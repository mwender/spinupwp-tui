// WordPress core updates over SSH — `wp core check-update` / `wp core update`,
// run as the site user in the site's real WordPress directory. The SpinupWP API
// has no core-update endpoint (it only reports a `wp_core_update` flag), so this
// is the same key-based SSH path the Plugins & themes view reads through.
//
// The WP dir is DETECTED, never assumed (see CLAUDE.md "WordPress layout rules"):
// detectWpDirScript finds core on /public/, root-webroot, and Bedrock (web/wp)
// layouts alike.
//
// Composer-managed core (Bedrock, Radicle) is allowed, deliberately: for a
// security hotfix, getting the patched files onto the server NOW matters more
// than keeping composer.lock in step. But it's a real divergence — the lock
// still pins the old version, so the next `composer install` (a git deploy, a
// clone) silently reverts the patch. The check reports the locked version so
// the UI can say exactly that before anything runs.

import type { Server, Site } from "../api/types.ts"
import { SSH_OPTS, sshPort } from "./dbBackup.ts"
import { detectWpDirScript } from "./serverClone.ts"
import { extractJsonArray, wpCliResolveScript } from "./wpCli.ts"
import { spawn } from "./spawn.ts"

export interface WpCoreOffer {
  version: string
  updateType: string // "minor" | "major" (wp-cli's update_type)
}

export interface WpCoreStatus {
  wpDir: string
  current: string
  offers: WpCoreOffer[] // newest first, as wp-cli lists them; [] = up to date
  multisite: boolean
  // Set when core is installed by Composer (roots/wordpress, johnpbloch/wordpress…):
  // the version composer.lock pins, which a later `composer install` restores.
  composer: { lockedVersion: string | null } | null
}

export type WpCoreCheckResult =
  | { ok: true; target: string; status: WpCoreStatus }
  | { ok: false; target: string; error: string }

export type WpCoreUpdateResult =
  | { ok: true; before: string; after: string; log: string }
  | { ok: false; error: string; log: string }

// Numeric, segment-wise version compare ("7.0" < "7.0.2" < "7.1"); non-numeric
// tails are ignored, which is fine for WordPress release numbers.
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0)
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// The two targets a bulk update can aim for. "line" = the newest release in the
// site's own major.minor line (7.0.2 → 7.0.x): WordPress backports security
// fixes there, so it's the low-risk hotfix. "newest" = the newest release,
// period (a major update for anyone on an older line). null = nothing to do.
export type WpTargetMode = "line" | "newest"

export function wpTarget(current: string, offers: WpCoreOffer[], mode: WpTargetMode): string | null {
  const line = (v: string) => v.split(".").slice(0, 2).join(".")
  const pool = mode === "line" ? offers.filter((o) => line(o.version) === line(current)) : offers
  let best: string | null = null
  for (const o of pool) if (compareVersions(o.version, current) > 0 && (!best || compareVersions(o.version, best) > 0)) best = o.version
  return best
}

// Composer packages that install WordPress core itself.
const CORE_PACKAGES = ["roots/wordpress", "roots/wordpress-no-content", "roots/wordpress-full", "johnpbloch/wordpress", "johnpbloch/wordpress-core"]

interface Prepared {
  target: string
  args: string[]
}

function prepare(server: Server, site: Site, sshUser: string | null): Prepared | { error: string; target: string } {
  const ip = server.ip_address
  const user = site.site_user ?? sshUser
  if (!ip) return { target: "(no IP)", error: "Server has no IP address." }
  if (!user) return { target: ip, error: "Site has no site user — can't SSH in to run wp-cli." }
  const target = `${user}@${ip}`
  return { target, args: ["ssh", ...SSH_OPTS, ...sshPort(server.ssh_port ?? null), target] }
}

// Shared preamble: locate core (sets $W, bails with ===NOTWP when there's none),
// then resolve $PHP/$WP pinned to the site's own PHP-CLI (see wpCli.ts).
function preamble(site: Site): string {
  const root = `/sites/${site.domain}/files`
  return [
    detectWpDirScript(root, site.public_folder ?? undefined),
    `if [ -z "$W" ]; then echo ===NOTWP; echo ===END; exit 0; fi`,
    wpCliResolveScript(site.php_version),
    // Every core command runs with plugins and themes unloaded: none of them need
    // either, and a plugin's PHP notices land on STDOUT under the CLI SAPI —
    // verified live on an Elementor Pro site under PHP 8.4, where a wall of
    // "Implicitly marking parameter … as nullable is deprecated" swallowed the
    // check-update JSON and the site read as up to date while two versions behind.
    // It also keeps a fataling plugin from blocking the core update that fixes it.
    `wpc() { "$PHP" "$WP" --path="$W" --skip-plugins --skip-themes "$@"; }`,
  ].join("\n")
}

async function run(args: string[], remote: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn([...args, remote], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, timeoutMs)
  const code = await proc.exited
  clearTimeout(timer)
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
  return { code, stdout, stderr }
}

function splitSections(out: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {}
  let current = ""
  for (const rawLine of out.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    const m = line.match(/^===([A-Z]+)$/)
    if (m) {
      current = m[1]
      sections[current] = []
    } else if (current) {
      sections[current].push(line)
    }
  }
  return sections
}

function sshFailure(code: number, stderr: string): string {
  return stderr.trim().split("\n").slice(-2).join(" ") || `ssh exited with code ${code}`
}

// Read the installed version, available updates, multisite-ness, and whether
// Composer owns core. Strictly read-only.
export async function checkWpCore(server: Server, site: Site, sshUser: string | null): Promise<WpCoreCheckResult> {
  const p = prepare(server, site, sshUser)
  if ("error" in p) return { ok: false, target: p.target, error: p.error }

  // composer.lock sits at the project root: $W/../.. for Bedrock (web/wp),
  // $W/.. for a public/ layout, or $W itself. The first lock that lists a core
  // package wins; PHP parses it (jq isn't guaranteed on the box).
  const pkgs = CORE_PACKAGES.map((n) => `'${n}'`).join(",")
  const lockPhp = `$l=json_decode(file_get_contents($argv[1]),true);foreach(array_merge($l["packages"]??[],$l["packages-dev"]??[]) as $p){if(in_array($p["name"],[${pkgs}],true)){echo $p["version"];exit(0);}}exit(1);`
  const remote = [
    preamble(site),
    `echo ===WPDIR; printf '%s\\n' "$W"`,
    // Trailing `echo`s are load-bearing: wp's JSON/plain output has no trailing
    // newline, so the next ===MARKER would glue onto it (see wpInventory.ts).
    `echo ===VERSION; wpc core version 2>/dev/null || true; echo`,
    `echo ===UPDATES; wpc core check-update --format=json 2>/dev/null || true; echo`,
    `echo ===MULTISITE; wpc core is-installed --network >/dev/null 2>&1 && echo yes || echo no`,
    `echo ===COMPOSER`,
    `for d in "$W/../.." "$W/.." "$W"; do if [ -f "$d/composer.lock" ]; then v=$("$PHP" -r ${shq(lockPhp)} "$d/composer.lock" 2>/dev/null) && { echo "locked $v"; break; }; fi; if [ -f "$d/composer.json" ] && grep -qE '"(${CORE_PACKAGES.join("|")})"' "$d/composer.json"; then echo "managed"; break; fi; done`,
    `echo ===END`,
  ].join("\n")

  let res: Awaited<ReturnType<typeof run>>
  try {
    res = await run(p.args, remote, 60_000)
  } catch (err) {
    return { ok: false, target: p.target, error: `Failed to launch ssh: ${(err as Error).message}` }
  }
  if (res.code !== 0 && !res.stdout.includes("===END")) return { ok: false, target: p.target, error: sshFailure(res.code, res.stderr) }

  const s = splitSections(res.stdout)
  if ("NOTWP" in s) return { ok: false, target: p.target, error: "No WordPress core found under the site's files — is this a WordPress site?" }
  const current = lastVersionLine(s.VERSION)
  if (!current) return { ok: false, target: p.target, error: "wp-cli couldn't read the WordPress version on this site." }

  // Belt and braces with --skip-plugins: a mu-plugin's notices still load, so
  // pull the JSON array out of any surrounding noise.
  // No match = "Success: WordPress is at the latest version." (plain text).
  const parsed = extractJsonArray(s.UPDATES) ?? []
  const offers: WpCoreOffer[] = parsed
    .filter((o): o is { version: string; update_type?: unknown } => !!o && typeof (o as { version?: unknown }).version === "string")
    .map((o) => ({ version: o.version, updateType: typeof o.update_type === "string" ? o.update_type : "" }))

  const comp = (s.COMPOSER ?? []).join("\n").trim()
  const locked = comp.match(/^locked (.+)$/m)
  const composer = locked ? { lockedVersion: locked[1].replace(/^v/, "") } : comp.includes("managed") ? { lockedVersion: null } : null

  return {
    ok: true,
    target: p.target,
    status: {
      wpDir: (s.WPDIR?.[0] || "").trim(),
      current,
      offers,
      multisite: (s.MULTISITE ?? []).join("").trim() === "yes",
      composer,
    },
  }
}

// Update core to `version`, then run the database upgrade (network-wide on
// multisite) and read the version back. If the update dies mid-way, WordPress
// leaves a .maintenance file that keeps the site on "Briefly unavailable" for
// up to 10 minutes — we remove it so a failure doesn't turn into downtime.
export async function updateWpCore(
  server: Server,
  site: Site,
  sshUser: string | null,
  version: string,
  multisite: boolean,
): Promise<WpCoreUpdateResult> {
  const p = prepare(server, site, sshUser)
  if ("error" in p) return { ok: false, error: p.error, log: "" }
  if (!/^[0-9][0-9A-Za-z.-]*$/.test(version)) return { ok: false, error: `Refusing odd version string "${version}".`, log: "" }

  const remote = [
    preamble(site),
    `echo ===BEFORE; wpc core version 2>/dev/null; echo`,
    `echo ===LOG`,
    `wpc core update --version=${version} 2>&1; rc=$?`,
    `if [ $rc -eq 0 ]; then wpc core update-db${multisite ? " --network" : ""} 2>&1 || rc=$?; fi`,
    `[ -f "$W/.maintenance" ] && rm -f "$W/.maintenance" && echo "Removed a leftover .maintenance file."`,
    `echo; echo ===RC; echo $rc`,
    `echo ===AFTER; wpc core version 2>/dev/null; echo`,
    `echo ===END`,
  ].join("\n")

  let res: Awaited<ReturnType<typeof run>>
  try {
    res = await run(p.args, remote, 300_000)
  } catch (err) {
    return { ok: false, error: `Failed to launch ssh: ${(err as Error).message}`, log: "" }
  }
  if (!res.stdout.includes("===END")) {
    return { ok: false, error: res.code === 0 ? "The update didn't finish (timed out?)." : sshFailure(res.code, res.stderr), log: res.stdout.trim() }
  }
  const s = splitSections(res.stdout)
  if ("NOTWP" in s) return { ok: false, error: "No WordPress core found under the site's files.", log: "" }
  const log = (s.LOG ?? []).join("\n").trim()
  const rc = Number((s.RC ?? []).join("").trim())
  const before = lastVersionLine(s.BEFORE)
  const after = lastVersionLine(s.AFTER)
  if (rc !== 0) {
    const lastErr = log.split("\n").filter((l) => /error|warning/i.test(l)).pop()
    return { ok: false, error: lastErr ?? `wp core update exited with code ${rc}.`, log }
  }
  if (after !== version) return { ok: false, error: `wp-cli reported success, but the site now reports ${after || "no version"} (wanted ${version}).`, log }
  return { ok: true, before, after, log }
}

// `wp core version` prints a bare version; pick that line out of any noise.
function lastVersionLine(lines: string[] | undefined): string {
  return [...(lines ?? [])].reverse().map((l) => l.trim()).find((l) => /^\d+\.\d+(\.\d+)?([-.][0-9A-Za-z.-]+)?$/.test(l)) ?? ""
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

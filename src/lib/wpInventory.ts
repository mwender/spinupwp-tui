// A site's installed plugins & themes over SSH — the `wp plugin list` / `wp theme
// list` detail the API never exposes (it only counts pending updates). Strictly
// read-only: we shell out to the local `ssh` client as the site user (the same
// non-interactive, key-based auth the health view uses) and run wp-cli in the
// site's real WordPress directory.
//
// The WP dir is DETECTED, never assumed: `public_folder` is a setting, not a fact
// (see CLAUDE.md "WordPress layout rules"), so we reuse the clone wizard's
// wp-settings.php probe to locate core on both /public/ and root-webroot sites.

import type { Server, Site } from "../api/types.ts"
import { SSH_OPTS, sshPort } from "./dbBackup.ts"
import { detectWpDirScript } from "./serverClone.ts"

// One plugin or theme, mirroring `wp {plugin,theme} list` columns.
export interface WpItem {
  name: string
  status: string // active | inactive | must-use | dropin | parent | active-network
  version: string
  update: string // available | none | unavailable
  updateVersion: string | null // the version an update would install, when available
}

export interface WpInventory {
  plugins: WpItem[]
  themes: WpItem[]
}

export type WpInventoryResult =
  | { ok: true; target: string; wpDir: string; inventory: WpInventory }
  | { ok: false; target: string; error: string }

// wp-cli's JSON fields (snake_case) → our WpItem.
interface RawItem {
  name?: string
  status?: string
  version?: string
  update?: string | boolean // wp emits `false` for must-use/dropin items
  update_version?: string
}

function normalize(raw: RawItem[]): WpItem[] {
  return raw.map((r) => ({
    name: r.name ?? "(unknown)",
    status: r.status ?? "",
    version: r.version ?? "",
    update: typeof r.update === "string" ? r.update : "none",
    updateVersion: r.update_version && r.update_version !== "" ? r.update_version : null,
  }))
}

// Split the batched remote output into its ===LABEL sections.
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

// wp --format=json emits a single-line JSON array; tolerate blank/garbage by
// returning [] rather than throwing (a fresh site can legitimately have 0 themes).
function parseJsonArray(lines: string[] | undefined): RawItem[] {
  const text = (lines ?? []).join("").trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function fetchWpInventory(
  server: Server,
  site: Site,
  sshUser: string | null,
): Promise<WpInventoryResult> {
  const ip = server.ip_address
  const user = site.site_user ?? sshUser
  if (!ip) return { ok: false, target: "(no IP)", error: "Server has no IP address." }
  if (!user) return { ok: false, target: ip, error: "Site has no site user — can't SSH in to read wp-cli." }
  const target = `${user}@${ip}`
  // We deliberately do NOT gate on site.is_wordpress: the API flag is unreliable
  // (it's false for many git/Bedrock sites and for Standard-WP sites SpinupWP
  // misclassified — e.g. a /public/ install imported as "Generic"). The remote
  // wp-settings.php probe below is authoritative for both /public/ and Bedrock
  // (web/wp) layouts, and returns a clean "no core found" error otherwise.
  const root = `/sites/${site.domain}/files`
  const fields = "name,status,version,update,update_version"
  // Detect the WP dir, bail cleanly if there's no core, then list both from it.
  const remote = [
    detectWpDirScript(root, site.public_folder ?? undefined),
    `if [ -z "$W" ]; then echo ===NOTWP; echo ===END; exit 0; fi`,
    `WP=$(command -v wp 2>/dev/null || echo /usr/local/bin/wp)`,
    `echo ===WPDIR; printf '%s\\n' "$W"`,
    // The trailing `echo` after each wp command is load-bearing: `wp --format=json`
    // emits NO trailing newline, so without it the next ===MARKER glues onto the end
    // of the JSON line — the marker never parses and JSON.parse chokes on it.
    `echo ===PLUGINS; "$WP" --path="$W" plugin list --fields=${fields} --format=json 2>/dev/null || true; echo`,
    `echo ===THEMES; "$WP" --path="$W" theme list --fields=${fields} --format=json 2>/dev/null || true; echo`,
    `echo ===END`,
  ].join("\n")

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, ...sshPort(server.ssh_port ?? null), target, remote], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
  } catch (err) {
    return { ok: false, target, error: `Failed to launch ssh: ${(err as Error).message}` }
  }
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, 45_000)
  const code = await proc.exited
  clearTimeout(timer)
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()

  if (code !== 0 && !stdout.includes("===END")) {
    const reason = stderr.trim().split("\n").slice(-2).join(" ") || `ssh exited with code ${code}`
    return { ok: false, target, error: reason }
  }

  const s = splitSections(stdout)
  if ("NOTWP" in s) {
    return { ok: false, target, error: `No WordPress core found under ${root} — is this a WordPress site?` }
  }
  const wpDir = (s.WPDIR?.[0] || root).trim()
  const plugins = normalize(parseJsonArray(s.PLUGINS))
  const themes = normalize(parseJsonArray(s.THEMES))
  return { ok: true, target, wpDir, inventory: { plugins, themes } }
}

// Count of items with an update available — for section-header badges.
export function updateCount(items: WpItem[]): number {
  return items.filter((i) => i.update === "available").length
}

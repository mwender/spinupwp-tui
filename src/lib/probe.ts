// Tier-2 stack probe: on-demand SSH inspection of a single site's filesystem to
// NAME what Tier-1 can only bucket (especially Non-WP apps) and read the WP
// version. This is the authoritative layer over the public_folder heuristic in
// `stack.ts`.
//
// SpinupWP on-disk layout (verified live): the site's system user (`site_user`)
// home dir IS the site root; the project lives at `$HOME/files` and the webroot
// is `$HOME/files` + the site's `public_folder` (e.g. `/public/`, `/web/`, `/`).
//
//   WHMCS     → webroot has configuration.php AND vendor/whmcs/
//   Bedrock   → files-root composer.json references roots/bedrock (or config/application.php)
//   Laravel   → files-root has artisan
//   WordPress → `wp core version` run from the webroot (works for Bedrock too,
//               via the site's wp-cli.yml), with a wp-includes/version.php fallback
//
// Strictly read-only and non-interactive (BatchMode), exactly like the health
// view's SSH usage.

import type { Server, Site } from "../api/types.ts"
import { detectWpDirScript } from "./serverClone.ts"
import { theme } from "./theme.ts"

export type ProbeKind = "wordpress" | "bedrock" | "radicle" | "whmcs" | "laravel" | "static" | "unknown"

// `onSelection` brightens the colors that are too low-contrast on the focused
// (bright-green) selection background — green-on-green and the faint greys.
export function probeKindColor(kind: ProbeKind, onSelection = false): string {
  switch (kind) {
    case "wordpress":
      return theme.accent
    case "bedrock":
      return onSelection ? theme.text : theme.good
    case "radicle":
      return onSelection ? theme.text : theme.purple
    case "whmcs":
      return theme.purple
    case "laravel":
      return theme.warn
    case "static":
      return onSelection ? theme.text : theme.textDim
    case "unknown":
      return onSelection ? theme.text : theme.textFaint
  }
}

export interface ProbeResult {
  kind: ProbeKind
  app: string // app family: "WordPress" | "Bedrock" | "WHMCS" | "Laravel" | "Unknown"
  version: string | null // WP/app version when known
  label: string // display label, e.g. "WHMCS", "WordPress 7.0", "Bedrock · WP 6.9.4"
}

export type ProbeOutcome =
  | { ok: true; target: string; result: ProbeResult }
  | { ok: false; target: string; error: string }

// Per-site SSH target. Unlike the health view (which connects as any site_user
// on the server), a probe must run as THIS site's user so `$HOME` is its dir.
export function resolveSiteSshTarget(site: Site, server: Server | undefined, sshUser: string | null): string {
  const ip = server?.ip_address
  if (!ip) return ""
  const user = sshUser || site.site_user || "root"
  return `${user}@${ip}`
}

export const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=7",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=/tmp/spinup-cm-%r@%h:%p",
  "-o", "ControlPersist=30s",
]

// public_folder comes from the API; restrict it to a safe path charset before
// embedding it in the remote command. Anything unexpected falls back to "/".
function safePublicFolder(pf: string | null): string {
  if (!pf || !/^[A-Za-z0-9/_.-]*$/.test(pf)) return "/"
  return pf
}

function buildRemoteScript(domain: string, publicFolder: string | null): string {
  const pf = safePublicFolder(publicFolder)
  const root = `/sites/${domain}/files`
  return [
    // detectWpDirScript anchors on the configured public folder (falling back to a
    // bounded find), so Bedrock's project root — one level above wherever its core
    // actually lives — is found at any nesting depth, not just when composer.json
    // sits directly in the files root. $D/$W from this are shadowed below by the
    // probe's own "webroot per public_folder" variables, which the rest of this
    // script (WHMCS/index/WP-version checks) intentionally keeps using as-is.
    detectWpDirScript(root, publicFolder ?? undefined),
    `BEDROCKROOT="$B"`,
    `RADICLEROOT="$RD"`,
    'F="$HOME/files"',
    `W="$HOME/files${pf}"`,
    'echo ===RADICLE; [ -n "$RADICLEROOT" ] && echo yes || echo no',
    'echo ===BEDROCK; [ -n "$BEDROCKROOT" ] && echo yes || echo no',
    'echo ===APPLICATION; test -f "$F/config/application.php" && echo yes || echo no',
    'echo ===ARTISAN; test -f "$F/artisan" && echo yes || echo no',
    'echo ===WHMCSCONF; test -f "$W/configuration.php" && echo yes || echo no',
    'echo ===WHMCSVENDOR; test -d "$W/vendor/whmcs" && echo yes || echo no',
    'echo ===WPVERSION; (cd "$W" 2>/dev/null && wp core version 2>/dev/null) || grep -oE "wp_version = .[0-9.]+" "$W/wp-includes/version.php" 2>/dev/null | grep -oE "[0-9][0-9.]*" | head -1',
    'echo ===INDEXHTML; test -f "$W/index.html" && echo yes || echo no',
    'echo ===INDEXPHP; test -f "$W/index.php" && echo yes || echo no',
    "echo ===END",
  ].join("; ")
}

export async function probeSite(
  site: Site,
  server: Server | undefined,
  sshUser: string | null,
): Promise<ProbeOutcome> {
  const target = resolveSiteSshTarget(site, server, sshUser)
  if (!target) return { ok: false, target: "(no IP)", error: "Site's server has no IP address." }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, target, buildRemoteScript(site.domain, site.public_folder)], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
  } catch (err) {
    return { ok: false, target, error: `Failed to launch ssh: ${(err as Error).message}` }
  }

  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, 15000)

  const exitCode = await proc.exited
  clearTimeout(timeout)
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()

  if (exitCode !== 0 || !stdout.includes("===END")) {
    const reason = stderr.trim().split("\n").slice(-2).join(" ") || `ssh exited with code ${exitCode}`
    return { ok: false, target, error: reason }
  }

  return { ok: true, target, result: classify(parseSections(stdout)) }
}

// Parse the labelled `===KEY` sections into single trimmed string values.
function parseSections(out: string): Record<string, string> {
  const sections: Record<string, string[]> = {}
  let current = ""
  for (const rawLine of out.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    const m = line.match(/^===([A-Z0-9]+)$/)
    if (m) {
      current = m[1]
      sections[current] = []
    } else if (current) {
      sections[current].push(line)
    }
  }
  const flat: Record<string, string> = {}
  for (const [k, lines] of Object.entries(sections)) flat[k] = lines.join("\n").trim()
  return flat
}

// Turn raw signals into a named stack. Order matters: name the distinctive apps
// (WHMCS, Bedrock, Laravel) before falling back to a generic WordPress version.
export function classify(sig: Record<string, string>): ProbeResult {
  const wpVersion = sig.WPVERSION ? sig.WPVERSION.trim() || null : null

  if (sig.WHMCSCONF === "yes" && sig.WHMCSVENDOR === "yes") {
    return { kind: "whmcs", app: "WHMCS", version: null, label: "WHMCS" }
  }
  // Checked before BEDROCK: Radicle's composer.json also requires
  // roots/bedrock-autoloader, so it would otherwise match the Bedrock signal too.
  if (sig.RADICLE === "yes") {
    return {
      kind: "radicle",
      app: "Radicle",
      version: wpVersion,
      label: wpVersion ? `Radicle · WP ${wpVersion}` : "Radicle",
    }
  }
  if (sig.BEDROCK === "yes" || sig.APPLICATION === "yes") {
    return {
      kind: "bedrock",
      app: "Bedrock",
      version: wpVersion,
      label: wpVersion ? `Bedrock · WP ${wpVersion}` : "Bedrock",
    }
  }
  if (sig.ARTISAN === "yes") {
    return { kind: "laravel", app: "Laravel", version: null, label: "Laravel" }
  }
  if (wpVersion) {
    return { kind: "wordpress", app: "WordPress", version: wpVersion, label: `WordPress ${wpVersion}` }
  }
  // No recognized server-side app: an index.html with no index.php is a static
  // site. Stay conservative — anything ambiguous remains "Unknown".
  if (sig.INDEXHTML === "yes" && sig.INDEXPHP !== "yes") {
    return { kind: "static", app: "Static HTML", version: null, label: "Static HTML" }
  }
  return { kind: "unknown", app: "Unknown", version: null, label: "Unknown" }
}

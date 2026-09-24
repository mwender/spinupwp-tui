// Resolve wp-cli through the SITE's own configured PHP-CLI, not the bare `wp`
// command. wp-cli's installed binary shebangs `#!/usr/bin/env php`, which
// resolves through PATH to the SERVER's system-DEFAULT PHP — which drifts
// toward whatever version was installed most recently, independent of any
// individual site's configured version, and can be missing extensions that
// version's CLI SAPI never got configured with.
//
// Verified live 2026-07-09 on a production server: the system default had
// drifted to 8.4, whose CLI lacked `mysqli` (its FPM pool likely never needed
// it — no site there runs 8.4), while a site's actual
// configured version (8.1) has a fully working php8.1-cli. Bare `wp` silently
// ran under 8.4 and failed on anything touching $wpdb (post/user/plugin list,
// option get) — while `wp core version`, and `wp db export/import/check/size`
// (they shell out to native mysql client tools, not through mysqli) were
// unaffected. Confirmed the fix directly: `/usr/bin/php8.1 /usr/local/bin/wp
// post list ...` returned correct data where bare `wp` errored.
//
// Only applies to REMOTE (SSH) wp-cli calls against SpinupWP-managed servers,
// which have this specific multi-PHP-version-drift shape. Local dev-machine
// wp-cli (e.g. dbSync.ts's prod→local pull) is a different environment with
// its own PHP entirely and is not affected — don't apply this there.

// Emits POSIX shell that resolves $WP (the wp-cli binary) and $PHP (the
// version-pinned interpreter, falling back to the bare `php` on PATH if the
// versioned binary isn't installed — never worse than today's behavior).
// Callers invoke `"$PHP" "$WP" ...` in place of bare `wp ...`.
export function wpCliResolveScript(phpVersion?: string | null): string {
  const phpBin = phpVersion ? `php${phpVersion}` : "php"
  return [`WP=$(command -v wp 2>/dev/null || echo /usr/local/bin/wp)`, `PHP=$(command -v ${phpBin} 2>/dev/null || command -v php)`].join("\n")
}

// Pull wp-cli's `--format=json` array out of a section of remote stdout that may
// also carry noise: under the CLI SAPI a plugin's PHP notices/deprecations print
// to STDOUT (2>/dev/null doesn't catch them), and with no newline of their own
// they can sit on the same line as the JSON — before it, or after it when they
// fire at shutdown (seen live: an Elementor Pro deprecation glued to the end of
// `plugin list` output). So: from every `[`, bracket-match to its closing `]`
// (skipping brackets inside JSON strings), and keep the longest slice that parses
// as an array of objects — which is what every wp-cli list is, and what notice
// text like "on line [3]" or "[array (" never is.
// Returns null when nothing parses, so callers can tell "wp-cli printed no list"
// (an error worth surfacing) from a genuinely empty `[]`.
export function extractJsonArray(lines: string[] | undefined): unknown[] | null {
  const text = (lines ?? []).join("\n")
  let best: unknown[] | null = null
  let bestLen = -1
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    const end = matchingBracket(text, start)
    if (end === -1 || end - start <= bestLen) continue
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(parsed) && parsed.every((o) => o !== null && typeof o === "object")) {
        best = parsed
        bestLen = end - start
      }
    } catch {
      /* not JSON from here — try the next `[` */
    }
  }
  return best
}

// Index of the `]` closing the `[` at `start`, or -1. Tracks JSON string state so
// a bracket inside a value (a plugin name, a URL) doesn't end the match early.
function matchingBracket(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === "\\") i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === "[" || ch === "{") depth++
    else if (ch === "]" || ch === "}") {
      depth--
      if (depth === 0) return ch === "]" ? i : -1
      if (depth < 0) return -1
    }
  }
  return -1
}

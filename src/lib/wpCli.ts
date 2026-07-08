// Resolve wp-cli through the SITE's own configured PHP-CLI, not the bare `wp`
// command. wp-cli's installed binary shebangs `#!/usr/bin/env php`, which
// resolves through PATH to the SERVER's system-DEFAULT PHP — which drifts
// toward whatever version was installed most recently, independent of any
// individual site's configured version, and can be missing extensions that
// version's CLI SAPI never got configured with.
//
// Verified live 2026-07-09 on web4.wenmarkdigital.com: the system default had
// drifted to 8.4, whose CLI lacked `mysqli` (its FPM pool likely never needed
// it — no site there runs 8.4), while lp.anchoredconstructiontn.com's actual
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

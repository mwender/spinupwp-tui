// Keep the current directory's .env out of the processes we spawn.
//
// Bun auto-loads .env files from the directory it was launched in, and every
// Bun.spawn inherits process.env. Run spinuptui from inside a site's checkout and
// that site's own .env — DB_NAME, DB_USER, DB_PASSWORD, WP_HOME — rides along into
// `bash -lc "wp …"`. A Bedrock config then reads *nothing*: its phpdotenv
// repository is immutable, so it skips keys that already exist in the
// environment, while `Env::$options` with USE_ENV_ARRAY reads only $_ENV — which
// PHP leaves empty for inherited variables when variables_order lacks "E" (the
// Homebrew default). Every DB constant comes out blank, and `wp db export` fails
// as "Access denied for user '<login name>'@'localhost' (using password: NO)".
//
// So: drop every key those files defined, except the ones this app reads itself —
// its token and provider credentials may legitimately live in a project-local
// .env (see config.ts) — and make every spawn inherit the cleaned environment
// (see defaultSpawnEnvToProcessEnv below). Must run before anything reads config
// or spawns, which is why index.tsx imports this module first.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Keys spinuptui reads from the environment on purpose.
const OWN = /^(SPINUP|CLOUDFLARE_API_TOKEN$|AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION)$|GODADDY_API_(KEY|SECRET)$)/

// Never removed, whatever a .env says: the spawned shells need these to work.
const ESSENTIAL = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME"])

// The files Bun loads, in its order: .env, .env.<NODE_ENV> (default
// development), then .env.local (skipped under test).
function loadedFiles(cwd: string): string[] {
  const mode = process.env.NODE_ENV || "development"
  const names = [".env", `.env.${mode}`]
  if (mode !== "test") names.push(".env.local")
  return names.map((n) => join(cwd, n)).filter((p) => existsSync(p))
}

// Key names only — values are irrelevant, so no quoting or expansion to get right.
export function dotenvKeys(text: string): string[] {
  const keys: string[] = []
  for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) keys.push(m[1]!)
  return keys
}

// Returns the keys removed, for tests and debugging.
export function scrubCwdDotenv(cwd = process.cwd()): string[] {
  const removed: string[] = []
  for (const file of loadedFiles(cwd)) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const key of dotenvKeys(text)) {
      if (OWN.test(key) || ESSENTIAL.has(key) || !(key in process.env)) continue
      delete process.env[key]
      removed.push(key)
    }
  }
  return removed
}

// Deleting from process.env is not enough on its own: a Bun.spawn with no `env`
// option hands the child Bun's *startup* environment, deletions and all ignored
// (confirmed on Bun 1.3.14). Passing `env: process.env` does honor them. Rather
// than trust every call site — 31 of them, and the next one written — default
// the option here, once. An explicit `env` from the caller still wins.
export function defaultSpawnEnvToProcessEnv(): void {
  const original = Bun.spawn
  const patched = ((...args: unknown[]) => {
    if (Array.isArray(args[0])) {
      const opts = (args[1] ?? {}) as { env?: unknown }
      return (original as (...a: unknown[]) => unknown)(args[0], { ...opts, env: opts.env ?? process.env })
    }
    const opts = (args[0] ?? {}) as { env?: unknown }
    return (original as (...a: unknown[]) => unknown)({ ...opts, env: opts.env ?? process.env })
  }) as typeof Bun.spawn
  Bun.spawn = patched
}

scrubCwdDotenv()
defaultSpawnEnvToProcessEnv()

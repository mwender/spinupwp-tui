// Keep the current directory's .env out of the processes we spawn.
//
// Bun auto-loads .env files from the directory it was launched in, and every
// spawned child inherits process.env. Run spinuptui from inside a site's checkout
// and that site's own .env — DB_NAME, DB_USER, DB_PASSWORD, WP_HOME — rides along
// into `bash -lc "wp …"`. A Bedrock config then reads *nothing*: its phpdotenv
// repository is immutable, so it skips keys that already exist in the
// environment, while `Env::$options` with USE_ENV_ARRAY reads only $_ENV — which
// PHP leaves empty for inherited variables when variables_order lacks "E" (the
// Homebrew default). Every DB constant comes out blank, and `wp db export` fails
// as "Access denied for user '<login name>'@'localhost' (using password: NO)".
//
// So: drop every key those files defined, except the ones this app reads itself —
// its token and provider credentials may legitimately live in a project-local
// .env (see config.ts). The provider keys have generic names a site's .env uses
// too (Bedrock keeps S3 media credentials under AWS_*), so those are only trusted
// from spinuptui's own project directory. Deleting from process.env only reaches children that are
// handed process.env explicitly, which is what src/lib/spawn.ts is for. Must run
// before anything reads config or spawns, which is why index.tsx imports this
// module first.

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"

// Keys spinuptui reads from the environment on purpose. Only spinuptui uses the
// SPINUP* names, so they're kept from any directory's .env.
const OWN = /^SPINUP/

// Provider credentials spinuptui also reads (config.ts). Kept only from the .env
// in spinuptui's own project directory — anywhere else they're a site's keys.
const PROVIDER = /^(CLOUDFLARE_API_TOKEN|AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION)|GODADDY_API_(KEY|SECRET))$/

// This file lives in <project>/src/lib.
const PROJECT_DIR = join(import.meta.dir, "..", "..")

function isProjectDir(dir: string): boolean {
  try {
    return realpathSync(dir) === realpathSync(PROJECT_DIR)
  } catch {
    return false
  }
}

// Never removed, whatever a .env says: the spawned shells need these to work.
const ESSENTIAL = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME"])

// The files Bun loads, in increasing precedence: .env, .env.<NODE_ENV> (default
// development), then .env.local (skipped under test).
function loadedFiles(cwd: string): string[] {
  const mode = process.env.NODE_ENV || "development"
  const names = [".env", `.env.${mode}`]
  if (mode !== "test") names.push(".env.local")
  return names.map((n) => join(cwd, n)).filter((p) => existsSync(p))
}

// Each key with the value the file gives it, or null where that value can't be
// read with certainty (variable expansion, escapes, multi-line quotes). The value
// only matters for telling a .env key from a shell one; see scrubCwdDotenv.
export function dotenvEntries(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/gm)) {
    out.set(m[1]!, dotenvValue(m[2]!.trim()))
  }
  return out
}

function dotenvValue(raw: string): string | null {
  const q = raw[0]
  if (q === "'" || q === "`" || q === '"') {
    const end = raw.indexOf(q, 1)
    if (end < 0) return null
    const inner = raw.slice(1, end)
    return q === '"' && /[$\\]/.test(inner) ? null : inner
  }
  const value = raw.replace(/\s+#.*$/, "").trim()
  return value.includes("$") ? null : value
}

// Returns the keys removed, for tests and debugging.
export function scrubCwdDotenv(cwd = process.cwd()): string[] {
  // Later files win, as they do in Bun.
  const entries = new Map<string, string | null>()
  for (const file of loadedFiles(cwd)) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const [key, value] of dotenvEntries(text)) entries.set(key, value)
  }
  const ownDir = isProjectDir(cwd)
  const removed: string[] = []
  for (const [key, value] of entries) {
    if (OWN.test(key) || (ownDir && PROVIDER.test(key)) || ESSENTIAL.has(key) || !(key in process.env)) continue
    // Bun never overrides a variable the shell already set, so a value that differs
    // from the file's came from the shell — keep it. When the file's value can't be
    // read with certainty, assume it's the file's and drop it.
    if (value !== null && process.env[key] !== value) continue
    delete process.env[key]
    removed.push(key)
  }
  return removed
}

scrubCwdDotenv()

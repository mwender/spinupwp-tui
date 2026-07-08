// "Update available" check: compare the running version to the latest GitHub
// release, so a `✨ vX.Y.Z` hint can nudge users — either to update in-app (`u`
// in the Help/About overlay, see runSelfUpdate below) or with a manual `git pull`.
//
// Polling model: checked once per launch, backed by a disk cache with a 6h TTL —
// so frequent open/close cycles reuse the cached result instead of hitting GitHub
// each time (releases are infrequent; the unauthenticated API allows 60 req/hr).
// Never throws and degrades gracefully offline.

import { join, sep } from "node:path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { configDir } from "../config.ts"
import { REPO_SLUG } from "../version.ts"

const CACHE_VERSION = 1
const TTL_MS = 6 * 60 * 60 * 1000 // 6 hours
const FETCH_TIMEOUT_MS = 5000

export interface UpdateInfo {
  current: string // running version
  latest: string // latest released version (no leading "v")
  url: string // release page
  updateAvailable: boolean
}

interface CacheFile {
  version: number
  checkedAt: number // epoch ms
  latest: string | null
  url: string | null
}

function cachePath(): string {
  return join(configDir(), "update-check.json")
}

// Parse "v1.2.3" / "1.2.3" → [1,2,3]; null when it doesn't look like a version.
function parseVersion(s: string): [number, number, number] | null {
  const m = s.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// Strictly-newer comparison (latest > current). Unparseable → false (never nag).
function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

function readCache(): CacheFile | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as CacheFile
    return parsed?.version === CACHE_VERSION ? parsed : null
  } catch {
    return null
  }
}

function writeCache(latest: string | null, url: string | null): void {
  try {
    mkdirSync(configDir(), { recursive: true })
    const file: CacheFile = { version: CACHE_VERSION, checkedAt: Date.now(), latest, url }
    writeFileSync(cachePath(), JSON.stringify(file))
  } catch {
    /* best-effort; a failed cache write just means we re-check next launch */
  }
}

function deriveInfo(current: string, latest: string | null, url: string | null): UpdateInfo | null {
  if (!latest) return null
  return { current, latest, url: url ?? `https://github.com/${REPO_SLUG}/releases`, updateAvailable: isNewer(latest, current) }
}

// Synchronous read of whatever we last cached — used to show a hint instantly on
// launch without waiting on the network. Returns null when nothing is cached.
export function cachedUpdateInfo(current: string): UpdateInfo | null {
  const c = readCache()
  return c ? deriveInfo(current, c.latest, c.url) : null
}

// Hit GitHub for the latest release; null on any failure (offline, rate limit, no
// releases yet). Times out so it can't hang the launch.
async function fetchLatestRelease(): Promise<{ latest: string; url: string } | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/latest`, {
      headers: {
        "User-Agent": "spinup-tui",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { tag_name?: string; html_url?: string }
    const tag = json.tag_name?.replace(/^v/i, "")
    if (!tag) return null
    return { latest: tag, url: json.html_url ?? `https://github.com/${REPO_SLUG}/releases` }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// The launch-time check: returns the freshest info we can, hitting GitHub only
// when the cache is stale (older than the TTL). Falls back to a stale cache if
// the network fails. Returns null only when we have nothing at all.
export async function refreshUpdateInfo(current: string): Promise<UpdateInfo | null> {
  const cache = readCache()
  if (cache && Date.now() - cache.checkedAt < TTL_MS) {
    return deriveInfo(current, cache.latest, cache.url)
  }
  const fetched = await fetchLatestRelease()
  if (fetched) {
    writeCache(fetched.latest, fetched.url)
    return deriveInfo(current, fetched.latest, fetched.url)
  }
  // Network failed — keep whatever we had so the hint doesn't flicker off.
  return cache ? deriveInfo(current, cache.latest, cache.url) : null
}

// ---- In-app updater (`u` in the Help/About overlay) ------------------------

// How this copy of the app was installed, which decides the update path shown
// in Help/About: a package-manager install (bun/npm global) lives under a
// node_modules dir and updates via `bun update -g spinuptui`; anything else is
// treated as a git checkout and updates via `git pull` (runSelfUpdate).
export type InstallChannel = "git" | "package"

export function installChannel(): InstallChannel {
  return import.meta.dir.includes(`${sep}node_modules${sep}`) ? "package" : "git"
}

// The one-liner Help shows for a package install (also used by runSelfUpdate's
// "not a checkout" message so every path names the same command).
export const PACKAGE_UPDATE_CMD = "bun update -g spinuptui"

// The real checkout directory, resolved through Bun's module system rather
// than process.cwd() — `spinuptui` is typically a global symlink invoked from
// wherever the user happens to be, so cwd is meaningless here. import.meta.dir
// follows the symlink to this file's REAL location (verified: it does not
// resolve to the symlink's own path or the invoking shell's cwd).
function checkoutRoot(): string {
  return join(import.meta.dir, "..", "..")
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

export interface SelfUpdateResult {
  ok: boolean
  message: string
  // package.json / bun.lock changed — the running code on disk now needs
  // `bun install` before it'll actually run.
  needsInstall: boolean
}

// `git pull --ff-only` in the checkout, with the safety rails a self-updater
// needs: refuse on a dirty tree (this is the user's own dev checkout, not an
// opaque install dir — never silently overwrite their uncommitted work), and
// never attempt a merge/rebase that could produce conflicts (--ff-only). Can't
// hot-reload the already-running process — the result always says "on disk",
// never implies the update is live without a restart.
// `cwd` defaults to the real checkout; overridable so this is testable against
// a disposable sandbox without ever touching the real repo's git state.
export async function runSelfUpdate(cwd: string = checkoutRoot()): Promise<SelfUpdateResult> {
  try {
    const isRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"])
    if (isRepo.code !== 0 || isRepo.stdout !== "true") {
      return { ok: false, message: `This install isn't a git checkout — update with \`${PACKAGE_UPDATE_CMD}\`.`, needsInstall: false }
    }
    const status = await git(cwd, ["status", "--porcelain"])
    if (status.stdout.length > 0) {
      return { ok: false, message: "Your checkout has uncommitted changes — commit or stash them, then try again.", needsInstall: false }
    }
    const before = await git(cwd, ["rev-parse", "HEAD"])
    const pull = await git(cwd, ["pull", "--ff-only"])
    if (pull.code !== 0) {
      return { ok: false, message: pull.stderr || pull.stdout || "git pull failed.", needsInstall: false }
    }
    const after = await git(cwd, ["rev-parse", "HEAD"])
    if (before.stdout && before.stdout === after.stdout) {
      return { ok: true, message: "Already up to date.", needsInstall: false }
    }
    const diff = await git(cwd, ["diff", "--name-only", before.stdout, after.stdout])
    const needsInstall = /(^|\/)(package\.json|bun\.lock)$/m.test(diff.stdout)
    return {
      ok: true,
      needsInstall,
      message: needsInstall
        ? "Updated on disk — run `bun install`, then press q and restart spinuptui."
        : "Updated on disk — press q and restart spinuptui.",
    }
  } catch (err) {
    return { ok: false, message: `Update failed: ${(err as Error).message}`, needsInstall: false }
  }
}

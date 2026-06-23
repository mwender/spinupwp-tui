// "Update available" check: compare the running version to the latest GitHub
// release, so a `✨ vX.Y.Z` hint can nudge users (who update with `git pull`).
//
// Polling model: checked once per launch, backed by a disk cache with a 6h TTL —
// so frequent open/close cycles reuse the cached result instead of hitting GitHub
// each time (releases are infrequent; the unauthenticated API allows 60 req/hr).
// Never throws and degrades gracefully offline.

import { join } from "node:path"
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

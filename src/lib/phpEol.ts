// PHP end-of-life data, computed from real EOL *dates* vs the current date —
// not a hard-coded "version X and below" cut, which would silently rot as the
// calendar advances. A version is EOL once its security-support date is past.
//
// Hybrid sourcing:
//   1. An embedded table of php.net's published dates is the offline default,
//      so flagging is correct with no network.
//   2. At startup we refresh from endoflife.date (cached to disk), which keeps
//      the data current and adds versions released after this build.
//
// A version with no known date is NOT flagged — we don't guess.

import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { configDir } from "../config.ts"

// Map of "major.minor" → security-support EOL date (ISO). Source: php.net
// supported-versions schedule. Refreshed at runtime from endoflife.date.
export const EMBEDDED_PHP_EOL: Record<string, string> = {
  "7.2": "2020-11-30",
  "7.3": "2021-12-06",
  "7.4": "2022-11-28",
  "8.0": "2023-11-26",
  "8.1": "2025-12-31",
  "8.2": "2026-12-31",
  "8.3": "2027-12-31",
  "8.4": "2028-12-31",
  "8.5": "2029-12-31",
}

// Refresh from the network at most this often.
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 6000
const ENDPOINT = "https://endoflife.date/api/php.json"

export type PhpEolDates = Record<string, string>

interface CacheFile {
  fetchedAt: number
  dates: PhpEolDates
}

export function phpEolCachePath(): string {
  return join(configDir(), "php-eol.json")
}

// Normalize "8.2.13" / "8.2" / "8" → "8.2" (the key php.net schedules by).
function majorMinor(version: string): string | null {
  const parts = version.split(".")
  const maj = Number.parseInt(parts[0], 10)
  if (!Number.isFinite(maj)) return null
  const min = Number.parseInt(parts[1] ?? "0", 10)
  return `${maj}.${Number.isFinite(min) ? min : 0}`
}

// True when `version`'s known EOL date is before `asOf`. Unknown → not flagged.
export function isPhpEol(version: string | null | undefined, dates: PhpEolDates, asOf: Date = new Date()): boolean {
  if (!version) return false
  const key = majorMinor(version)
  if (!key) return false
  const eol = dates[key]
  if (!eol) return false
  const t = Date.parse(eol)
  return Number.isFinite(t) && t < asOf.getTime()
}

// The PHP versions to offer in the upgrade picker. Derived dynamically from the
// (network-refreshed) EOL schedule so it tracks new releases (8.5, 8.6, …) on its
// own rather than rotting in a hard-coded list. We keep the modern major (8.x),
// drop ancient 7.x, and always include the site's current version even if the
// schedule no longer lists it. Not filtered to "installed on the server" —
// SpinupWP installs a version on demand the first time a site is assigned it.
export function offeredPhpVersions(dates: PhpEolDates, current?: string | null): string[] {
  const set = new Set<string>()
  for (const key of Object.keys(dates)) {
    const maj = Number.parseInt(key.split(".")[0] ?? "", 10)
    if (maj >= 8) set.add(key)
  }
  const cur = current ? majorMinor(current) : null
  if (cur) set.add(cur)
  return [...set].sort((a, b) => phpSortKey(a) - phpSortKey(b))
}

// Numeric sort key for "8.10" > "8.2" correctness (major*100 + minor).
export function phpSortKey(version: string | null | undefined): number {
  if (!version) return -1
  const [maj, min] = version.split(".").map((n) => Number.parseInt(n, 10))
  if (!Number.isFinite(maj)) return -1
  return maj * 100 + (Number.isFinite(min) ? min : 0)
}

function loadCache(): CacheFile | null {
  try {
    const path = phpEolCachePath()
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile
    if (!parsed?.dates || typeof parsed.fetchedAt !== "number") return null
    return parsed
  } catch {
    return null
  }
}

// The dates to use right now: embedded defaults overlaid with cached fetch data.
export function resolvePhpEolDates(): PhpEolDates {
  return { ...EMBEDDED_PHP_EOL, ...(loadCache()?.dates ?? {}) }
}

function cacheIsFresh(): boolean {
  const c = loadCache()
  return c != null && Date.now() - c.fetchedAt < REFRESH_AFTER_MS
}

// Fetch the live PHP schedule from endoflife.date. Returns null on any failure
// (offline, timeout, bad shape) so callers fall back to embedded/cached data.
async function fetchPhpEolDates(): Promise<PhpEolDates | null> {
  try {
    const res = await fetch(ENDPOINT, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const cycles = (await res.json()) as { cycle?: string; eol?: string | boolean }[]
    if (!Array.isArray(cycles)) return null
    const dates: PhpEolDates = {}
    for (const c of cycles) {
      if (typeof c.cycle === "string" && typeof c.eol === "string") dates[c.cycle] = c.eol
    }
    return Object.keys(dates).length > 0 ? dates : null
  } catch {
    return null
  }
}

// Refresh the cache if stale; returns the freshly merged dates when it updated,
// or null when nothing changed (cache still fresh, or the fetch failed). Never
// throws — PHP-EOL data is best-effort decoration.
export async function refreshPhpEolDates(): Promise<PhpEolDates | null> {
  if (cacheIsFresh()) return null
  const fetched = await fetchPhpEolDates()
  if (!fetched) return null
  try {
    await mkdir(configDir(), { recursive: true })
    const file: CacheFile = { fetchedAt: Date.now(), dates: fetched }
    await Bun.write(phpEolCachePath(), JSON.stringify(file, null, 2) + "\n")
  } catch {
    /* best-effort cache write */
  }
  return { ...EMBEDDED_PHP_EOL, ...fetched }
}

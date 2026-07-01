// Ubuntu end-of-life data for the OS a SpinupWP server runs on, computed from
// real EOL *dates* vs the current date — same approach as php-eol (phpEol.ts).
//
// Hybrid sourcing:
//   1. An embedded table of Canonical's published LTS dates is the offline
//      default, so flagging is correct with no network.
//   2. At startup we refresh from endoflife.date (cached to disk), which keeps
//      the data current and adds releases published after this build.
//
// A version with no known date is NOT flagged — we don't guess. SpinupWP only
// provisions Ubuntu LTS releases, so only those are tracked.

import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { configDir } from "../config.ts"

// Map of "YY.MM" → standard security-support EOL date (ISO). Source:
// Canonical's published LTS schedule. Refreshed at runtime from endoflife.date.
export const EMBEDDED_UBUNTU_EOL: Record<string, string> = {
  "16.04": "2021-04-30",
  "18.04": "2023-05-31",
  "20.04": "2025-04-30",
  "22.04": "2027-04-30",
  "24.04": "2029-04-30",
}

// Refresh from the network at most this often.
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 6000
const ENDPOINT = "https://endoflife.date/api/ubuntu.json"

export type UbuntuEolDates = Record<string, string>

interface CacheFile {
  fetchedAt: number
  dates: UbuntuEolDates
}

export function ubuntuEolCachePath(): string {
  return join(configDir(), "ubuntu-eol.json")
}

// Normalize "20.04.6" / "20.04" → "20.04" (the key Canonical schedules by).
function releaseKey(version: string): string | null {
  const parts = version.split(".")
  if (parts.length < 2) return null
  const year = Number.parseInt(parts[0] ?? "", 10)
  const month = parts[1] ?? ""
  if (!Number.isFinite(year) || !/^\d{2}$/.test(month)) return null
  return `${parts[0]}.${month}`
}

// True when `version`'s known EOL date is before `asOf`. Unknown → not flagged.
export function isUbuntuEol(version: string | null | undefined, dates: UbuntuEolDates, asOf: Date = new Date()): boolean {
  if (!version) return false
  const key = releaseKey(version)
  if (!key) return false
  const eol = dates[key]
  if (!eol) return false
  const t = Date.parse(eol)
  return Number.isFinite(t) && t < asOf.getTime()
}

function loadCache(): CacheFile | null {
  try {
    const path = ubuntuEolCachePath()
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile
    if (!parsed?.dates || typeof parsed.fetchedAt !== "number") return null
    return parsed
  } catch {
    return null
  }
}

// The dates to use right now: embedded defaults overlaid with cached fetch data.
export function resolveUbuntuEolDates(): UbuntuEolDates {
  return { ...EMBEDDED_UBUNTU_EOL, ...(loadCache()?.dates ?? {}) }
}

function cacheIsFresh(): boolean {
  const c = loadCache()
  return c != null && Date.now() - c.fetchedAt < REFRESH_AFTER_MS
}

// Fetch the live Ubuntu release schedule from endoflife.date. Returns null on
// any failure (offline, timeout, bad shape) so callers fall back to
// embedded/cached data.
async function fetchUbuntuEolDates(): Promise<UbuntuEolDates | null> {
  try {
    const res = await fetch(ENDPOINT, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const cycles = (await res.json()) as { cycle?: string; eol?: string | boolean }[]
    if (!Array.isArray(cycles)) return null
    const dates: UbuntuEolDates = {}
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
// throws — Ubuntu-EOL data is best-effort decoration.
export async function refreshUbuntuEolDates(): Promise<UbuntuEolDates | null> {
  if (cacheIsFresh()) return null
  const fetched = await fetchUbuntuEolDates()
  if (!fetched) return null
  try {
    await mkdir(configDir(), { recursive: true })
    const file: CacheFile = { fetchedAt: Date.now(), dates: fetched }
    await Bun.write(ubuntuEolCachePath(), JSON.stringify(file, null, 2) + "\n")
  } catch {
    /* best-effort cache write */
  }
  return { ...EMBEDDED_UBUNTU_EOL, ...fetched }
}

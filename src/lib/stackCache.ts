// Disk-backed cache for Tier-2 probe results, keyed by site id.
//
// Lifecycle (agreed model): hydrate-on-startup, write-on-probe.
//   - load()  reads stack-cache.json into memory once at startup (no SSH).
//   - set()   is called after a successful `d` probe; it upserts the entry and
//             writes the whole file back immediately (write-through), so a probe
//             survives even if the TUI is killed with q / Ctrl+C.
// Probing itself is always on-demand and per-site — this cache exists to avoid
// repeating the slow SSH round-trips across launches, not to save RAM. It's a
// deliberately small, reusable pattern for other expensive derived data later.

import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdir } from "node:fs/promises"
import { configDir } from "../config.ts"
import type { ProbeResult } from "./probe.ts"

const CACHE_VERSION = 1

export interface CachedProbe {
  result: ProbeResult
  detectedAt: number // epoch ms
  signature: string // invalidation key (see siteSignature)
}

interface CacheFile {
  version: number
  entries: Record<string, CachedProbe> // key: String(site.id)
}

export function stackCachePath(): string {
  return join(configDir(), "stack-cache.json")
}

// A cached probe is considered stale when the site's relevant shape changes.
// Keying on is_wordpress + public_folder catches the cases that would alter the
// probe's target paths or expected result.
export function siteSignature(site: { is_wordpress: boolean; public_folder: string | null }): string {
  return `${site.is_wordpress}:${site.public_folder ?? ""}`
}

export class StackCache {
  private entries = new Map<number, CachedProbe>()
  // Serializes disk writes so concurrent probes (batch mode) can't tear the
  // file or drop each other's updates. Each persist() runs after the previous.
  private writeChain: Promise<void> = Promise.resolve()

  // Read the cache file into memory. Never throws — a missing or corrupt file
  // simply yields an empty cache.
  load(): void {
    try {
      const path = stackCachePath()
      if (!existsSync(path)) return
      const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile
      if (parsed?.version !== CACHE_VERSION || !parsed.entries) return
      for (const [k, v] of Object.entries(parsed.entries)) {
        const id = Number(k)
        if (Number.isFinite(id) && v?.result) this.entries.set(id, v)
      }
    } catch {
      /* ignore corrupt/unreadable cache — start empty */
    }
  }

  // Any cached entry (even if stale), for display.
  get(siteId: number): CachedProbe | undefined {
    return this.entries.get(siteId)
  }

  // True when the cached entry exists but no longer matches the site's shape,
  // so the UI can hint that a re-probe is warranted.
  isStale(siteId: number, signature: string): boolean {
    const e = this.entries.get(siteId)
    return e != null && e.signature !== signature
  }

  // Upsert a probe result and persist immediately (write-through).
  async set(siteId: number, result: ProbeResult, signature: string): Promise<void> {
    this.entries.set(siteId, { result, detectedAt: Date.now(), signature })
    await this.persist()
  }

  // A copy of all entries (for rendering aggregates without exposing the map).
  snapshot(): Map<number, CachedProbe> {
    return new Map(this.entries)
  }

  size(): number {
    return this.entries.size
  }

  // Queue this write behind any in-flight one. Each write serializes the
  // current entries map (which already includes all sets so far), so ordering
  // only needs to prevent overlapping file writes, not preserve per-set diffs.
  private persist(): Promise<void> {
    // `.catch` keeps the chain alive if one write fails (cache is best-effort).
    this.writeChain = this.writeChain.then(() => this.writeFile()).catch(() => {})
    return this.writeChain
  }

  private async writeFile(): Promise<void> {
    await mkdir(configDir(), { recursive: true })
    const file: CacheFile = { version: CACHE_VERSION, entries: {} }
    for (const [id, entry] of this.entries) file.entries[String(id)] = entry
    const path = stackCachePath()
    await Bun.write(path, JSON.stringify(file, null, 2) + "\n")
    try {
      await chmod(path, 0o600)
    } catch {
      /* best-effort on filesystems without POSIX perms */
    }
  }
}

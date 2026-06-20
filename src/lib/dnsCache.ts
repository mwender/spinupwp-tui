// Disk-backed cache for DNS zone-host lookups, keyed by normalized domain.
//
// Modeled on stackCache.ts (same hydrate-on-startup / write-through lifecycle).
// DNS host rarely changes — except during the very migration you're using this
// for — so entries are time-stamped: the UI shows the age and offers a refresh,
// and a 24h staleness window keeps long-lived caches honest across launches.
//
// Keyed by the NORMALIZED domain (www-stripped, lowercased) rather than the zone
// apex, so a lookup can hit the cache WITHOUT a network round-trip (we can't know
// a domain's apex until we resolve it). www + apex share one key; a separate
// subdomain that happens to share a zone just stores a duplicate entry — cheap.

import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdir } from "node:fs/promises"
import { configDir } from "../config.ts"
import type { ZoneHost } from "./dns.ts"

const CACHE_VERSION = 1
const STALE_MS = 24 * 60 * 60 * 1000 // 24h

export interface CachedDns {
  zone: ZoneHost | null // null = looked up, no host found (unregistered / unresolvable)
  checkedAt: number // epoch ms
}

interface CacheFile {
  version: number
  entries: Record<string, CachedDns> // key: normalized domain
}

export function dnsCachePath(): string {
  return join(configDir(), "dns-cache.json")
}

export class DnsCache {
  private entries = new Map<string, CachedDns>()
  // Serializes writes so concurrent batch lookups can't tear the file.
  private writeChain: Promise<void> = Promise.resolve()

  // Read the cache file into memory. Never throws — a missing/corrupt file yields
  // an empty cache.
  load(): void {
    try {
      const path = dnsCachePath()
      if (!existsSync(path)) return
      const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile
      if (parsed?.version !== CACHE_VERSION || !parsed.entries) return
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (k && v && typeof v.checkedAt === "number") this.entries.set(k, v)
      }
    } catch {
      /* ignore corrupt/unreadable cache — start empty */
    }
  }

  get(key: string): CachedDns | undefined {
    return this.entries.get(key)
  }

  isStale(key: string): boolean {
    const e = this.entries.get(key)
    return e == null || Date.now() - e.checkedAt > STALE_MS
  }

  // Upsert a lookup result and persist immediately (write-through).
  async set(key: string, zone: ZoneHost | null): Promise<void> {
    this.entries.set(key, { zone, checkedAt: Date.now() })
    await this.persist()
  }

  // A copy of all entries (for rendering without exposing the map).
  snapshot(): Map<string, CachedDns> {
    return new Map(this.entries)
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.writeFile()).catch(() => {})
    return this.writeChain
  }

  private async writeFile(): Promise<void> {
    await mkdir(configDir(), { recursive: true })
    const file: CacheFile = { version: CACHE_VERSION, entries: {} }
    for (const [k, entry] of this.entries) file.entries[k] = entry
    const path = dnsCachePath()
    await Bun.write(path, JSON.stringify(file, null, 2) + "\n")
    try {
      await chmod(path, 0o600)
    } catch {
      /* best-effort on filesystems without POSIX perms */
    }
  }
}

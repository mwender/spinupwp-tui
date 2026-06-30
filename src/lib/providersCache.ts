// Disk cache of verified provider zone sets, keyed by connection id.
//
// Holds only the RESULT of verification (zone names + account labels + an age) —
// NOT the credentials themselves (those live in config.json). Lets the ACCESS
// column populate at startup without re-hitting every provider; a visible age +
// a re-verify key keep it honest. Modeled on dnsCache.ts.
//
// Staleness: entries older than STALE_TTL_MS are dropped on load so they re-verify
// (see STALE_TTL_MS below) — the general-case fix for a zone registered after the
// last verify (DNS inventory ACCESS column, clone Plan pre-flight), complementing
// the vanity/clone resolveZoneConn re-verify-on-miss self-heal.

import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdir } from "node:fs/promises"
import { configDir } from "../config.ts"
import type { VerifiedZone } from "./providers.ts"

// v2: VerifiedZone gained `nameservers` + `account` (was accountId/accountName).
// Old entries are dropped on load so connections re-verify with the new shape.
const CACHE_VERSION = 2

// Backlog #3 (2026-06-27): entries older than this are dropped on load so they
// lazily RE-VERIFY (via the "no cache entry → verifyConnectionById" path in the
// views) instead of serving a stale zone list forever. This is what lets a zone
// registered since the last verify become visible without a manual bust — the
// general-case complement to the vanity/clone resolveZoneConn self-heal. We DROP
// (not eagerly re-verify) on purpose: the cache exists so startup doesn't hit every
// provider; freshness is reclaimed the next time a view actually needs the zone.
const STALE_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export interface VerifiedConn {
  ok: boolean
  zones: VerifiedZone[]
  accountLabel: string
  error?: string
  verifiedAt: number // epoch ms
}

interface CacheFile {
  version: number
  entries: Record<string, VerifiedConn> // key: connection id
}

export function providersCachePath(): string {
  return join(configDir(), "providers-cache.json")
}

export class ProvidersCache {
  private entries = new Map<string, VerifiedConn>()
  private writeChain: Promise<void> = Promise.resolve()

  load(): void {
    try {
      const path = providersCachePath()
      if (!existsSync(path)) return
      const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile
      if (parsed?.version !== CACHE_VERSION || !parsed.entries) return
      const now = Date.now()
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (!k || !v || typeof v.verifiedAt !== "number") continue
        if (now - v.verifiedAt > STALE_TTL_MS) continue // stale → drop so it re-verifies
        this.entries.set(k, v)
      }
    } catch {
      /* ignore corrupt/unreadable cache — start empty */
    }
  }

  get(id: string): VerifiedConn | undefined {
    return this.entries.get(id)
  }

  snapshot(): Map<string, VerifiedConn> {
    return new Map(this.entries)
  }

  async set(id: string, conn: VerifiedConn): Promise<void> {
    this.entries.set(id, conn)
    await this.persist()
  }

  async delete(id: string): Promise<void> {
    if (!this.entries.delete(id)) return
    await this.persist()
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.writeFile()).catch(() => {})
    return this.writeChain
  }

  private async writeFile(): Promise<void> {
    await mkdir(configDir(), { recursive: true })
    const file: CacheFile = { version: CACHE_VERSION, entries: {} }
    for (const [k, entry] of this.entries) file.entries[k] = entry
    const path = providersCachePath()
    await Bun.write(path, JSON.stringify(file, null, 2) + "\n")
    try {
      await chmod(path, 0o600)
    } catch {
      /* best-effort */
    }
  }
}

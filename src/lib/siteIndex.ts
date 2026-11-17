// A small on-disk list of the account's site domains and server names, so shell
// completion can offer them without an API round trip on every Tab. The
// dashboard rewrites it each time it loads servers and sites; completion reads
// it, and refreshes it from the API itself only when it's missing or older than
// MAX_AGE (and then gives up after a few seconds rather than hang the shell).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { profileDataDir } from "../config.ts"
import type { Server, Site } from "../api/types.ts"

export interface SiteIndex {
  fetchedAt: string
  sites: { domain: string; server: string }[]
  servers: string[]
}

const FILE = "site-index.json"
export const MAX_AGE_MS = 6 * 60 * 60 * 1000

function path(): string {
  return join(profileDataDir(), FILE)
}

export function buildSiteIndex(servers: Server[], sites: Site[], now = new Date()): SiteIndex {
  const names = new Map(servers.map((s) => [s.id, s.name]))
  return {
    fetchedAt: now.toISOString(),
    sites: sites.map((s) => ({ domain: s.domain, server: names.get(s.server_id) ?? "" })).sort((a, b) => a.domain.localeCompare(b.domain)),
    servers: servers.map((s) => s.name).sort(),
  }
}

export function readSiteIndex(): SiteIndex | null {
  try {
    const v = JSON.parse(readFileSync(path(), "utf8")) as SiteIndex
    return Array.isArray(v.sites) && Array.isArray(v.servers) ? v : null
  } catch {
    return null
  }
}

// Best effort: a failed write only means completion refreshes it later.
export function saveSiteIndex(servers: Server[], sites: Site[]): void {
  try {
    mkdirSync(profileDataDir(), { recursive: true })
    writeFileSync(path(), JSON.stringify(buildSiteIndex(servers, sites)) + "\n")
  } catch {
    // ignore
  }
}

export function isFresh(index: SiteIndex | null, now = Date.now()): boolean {
  return !!index && now - Date.parse(index.fetchedAt) < MAX_AGE_MS
}

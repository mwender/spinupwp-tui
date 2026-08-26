// Local working-copy links, read/written outside the React store.
//
// The TUI's store owns an authoritative in-memory Map and persists the whole
// map on every change (see store.tsx's persistLinks), so it doesn't need these.
// The CLI has no store: it reads the config once and writes a single link back,
// merging rather than replacing so a concurrent TUI session's other links
// survive. Both paths end up in the same config key (`localSites`).

import { loadConfig, saveConfig } from "../config.ts"
import { normalizeLink, type LocalLink } from "./local.ts"

// The link recorded for a site id, if any.
export function readLink(siteId: number): LocalLink | undefined {
  const raw = loadConfig().localSites[String(siteId)]
  return raw ? normalizeLink(raw) : undefined
}

// Merge one link into the stored set. Re-reads the config immediately before
// writing so we don't clobber links made since this process started.
export async function writeLink(siteId: number, link: LocalLink): Promise<void> {
  const current = loadConfig().localSites
  await saveConfig({ localSites: { ...current, [String(siteId)]: normalizeLink(link) } })
}

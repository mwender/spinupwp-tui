// Pure helpers for the "create a server" flow (backlog item 5, build 1).
// No I/O — the API calls live in the client; the orchestration in the store.
// Here: map a source server's provider/specs onto the provider metadata catalog,
// format specs + cost, and suggest a server name from the existing fleet.

import type { Server, ProviderMetadata, ProviderSize, ProviderRegion } from "../api/types.ts"

// The provider keys the API recognizes for metadata + create.
export type ProviderKey = "digitalocean" | "vultr" | "linode" | "hetzner"
export const PROVIDER_KEYS: ProviderKey[] = ["digitalocean", "vultr", "linode", "hetzner"]

// All regions across continents, flattened in catalog order (for the picker).
export function allRegions(md: ProviderMetadata | undefined): ProviderRegion[] {
  if (!md) return []
  return Object.values(md.regions).flat()
}

// A sensible default region (first available, else first overall).
export function firstRegion(md: ProviderMetadata | undefined): ProviderRegion | undefined {
  const all = allRegions(md)
  return all.find((r) => r.available !== false) ?? all[0]
}

// Normalize the API's free-form provider_name ("DigitalOcean", "Akamai/Linode",
// "Hetzner Cloud") to the key the metadata + create endpoints use.
export function providerKeyFromName(name: string | null | undefined): ProviderKey | null {
  const n = (name ?? "").toLowerCase()
  if (n.includes("digitalocean") || n.includes("digital ocean")) return "digitalocean"
  if (n.includes("vultr")) return "vultr"
  if (n.includes("linode") || n.includes("akamai")) return "linode"
  if (n.includes("hetzner")) return "hetzner"
  return null
}

// A human label for a provider key (for the form + confirm screens).
export function providerLabel(key: ProviderKey): string {
  return { digitalocean: "DigitalOcean", vultr: "Vultr", linode: "Linode", hetzner: "Hetzner" }[key]
}

export function sizeBySlug(md: ProviderMetadata | undefined, slug: string | null | undefined): ProviderSize | undefined {
  if (!md || !slug) return undefined
  return md.sizes.find((s) => s.slug === slug)
}

// Flatten the continent-grouped regions to find one by slug. Case-insensitive
// because a Server's `region` comes back as a code ("HIL") while the metadata
// slugs are lowercase ("hil").
export function regionBySlug(md: ProviderMetadata | undefined, slug: string | null | undefined): ProviderRegion | undefined {
  if (!md || !slug) return undefined
  const target = slug.toLowerCase()
  for (const group of Object.values(md.regions)) {
    const hit = group.find((r) => r.slug.toLowerCase() === target)
    if (hit) return hit
  }
  return undefined
}

// Parse a Server's human-readable `size` ("8 GB / 4 vCPUs") into specs. The API
// returns this display string, NOT a size slug, so matching to the catalog is by
// vCPU + memory rather than by slug.
export function parseSizeSpec(display: string | null | undefined): { vcpus: number | null; memoryMb: number | null } {
  const d = display ?? ""
  const mem = /(\d+(?:\.\d+)?)\s*(gb|mb)/i.exec(d)
  const memoryMb = mem ? Math.round(parseFloat(mem[1]) * (/gb/i.test(mem[2]) ? 1024 : 1)) : null
  const cpu = /(\d+)\s*v?cpu/i.exec(d)
  const vcpus = cpu ? parseInt(cpu[1], 10) : null
  return { vcpus, memoryMb }
}

// Match a vCPU+memory spec to the closest size slug from a CANDIDATE list. Pass
// the region's available sizes (sizesForRegion) — NOT the whole catalog — so we
// never match a size that isn't offered in the chosen region. (A provider can have
// several sizes with identical specs across region-specific lines, e.g. Hetzner's
// EU-only `cx33` vs the global `cpx31`, both 4 vCPU / 8 GB; matching globally can
// pick one the region doesn't sell, which then gets dropped.) This is the basis
// for carrying a chosen spec across providers when switching. Returns null only
// when the candidate list is empty.
export function matchSizeBySpec(sizes: ProviderSize[], vcpus: number | null, memoryMb: number | null): string | null {
  if (sizes.length === 0) return null
  const byCpu = vcpus != null ? sizes.filter((s) => s.vcpus === vcpus) : []
  const pool = byCpu.length ? byCpu : sizes
  if (memoryMb == null) return pool[0].slug
  let best = pool[0]
  let bestDiff = Infinity
  for (const s of pool) {
    const diff = Math.abs(s.memory - memoryMb)
    if (diff < bestDiff) {
      bestDiff = diff
      best = s
    }
  }
  return best.slug
}

// Convenience: match a Server's display `size` string ("8 GB / 4 vCPUs") against a
// candidate list.
export function matchSizeSlug(sizes: ProviderSize[], display: string | null | undefined): string | null {
  const { vcpus, memoryMb } = parseSizeSpec(display)
  return matchSizeBySpec(sizes, vcpus, memoryMb)
}

// The sizes a given region offers, as full size objects, in catalog order.
// Falls back to all sizes if the region isn't found (older/unknown region slug).
export function sizesForRegion(md: ProviderMetadata | undefined, regionSlug: string | null | undefined): ProviderSize[] {
  if (!md) return []
  const region = regionBySlug(md, regionSlug)
  if (!region) return md.sizes
  const allowed = new Set(region.sizes)
  const inRegion = md.sizes.filter((s) => allowed.has(s.slug))
  return inRegion.length ? inRegion : md.sizes
}

// "2 vCPU / 4 GB / 80 GB" — memory comes back in MB.
export function formatSize(s: ProviderSize): string {
  const mem = s.memory >= 1024 ? `${Math.round(s.memory / 1024)} GB` : `${s.memory} MB`
  return `${s.vcpus} vCPU / ${mem} / ${s.disk} GB`
}

// "$8.49/mo" (+ backups when enabled and priced).
export function formatCost(s: ProviderSize | undefined, backups = false): string {
  if (!s || typeof s.priceMonthly !== "number") return "—"
  let total = s.priceMonthly
  if (backups && typeof s.backupPriceMonthly === "number") total += s.backupPriceMonthly
  return `$${total.toFixed(2)}/mo`
}

// Parse a name into (prefix, number, suffix) when it has a numbered component,
// e.g. "web11.example.com" → ["web", 11, ".example.com"]. Null when unnumbered.
function parseNumbered(name: string): { prefix: string; num: number; suffix: string } | null {
  const m = /^(.*?)(\d+)(\D.*)?$/.exec(name ?? "")
  if (!m) return null
  return { prefix: m[1], num: Number(m[2]), suffix: m[3] ?? "" }
}

// Suggest the next server name from the fleet's naming convention. Detects a
// numbered pattern (prefix + number + optional suffix, e.g. "web11.example.com")
// and proposes the next in the dominant series ("web12.example.com"). Returns ""
// when no numbered convention is detectable — the user names it themselves.
export function suggestServerName(servers: Server[]): string {
  // Group numbered names by (prefix, suffix); track the count + the max number.
  const groups = new Map<string, { prefix: string; suffix: string; max: number; count: number }>()
  for (const s of servers) {
    const p = parseNumbered(s.name ?? "")
    if (!p) continue
    const key = JSON.stringify([p.prefix, p.suffix]) // unambiguous composite key
    const g = groups.get(key)
    if (!g) groups.set(key, { prefix: p.prefix, suffix: p.suffix, max: p.num, count: 1 })
    else {
      g.max = Math.max(g.max, p.num)
      g.count += 1
    }
  }
  if (groups.size === 0) return ""
  // Prefer the convention used by the most servers; break ties by higher number.
  let best: { prefix: string; suffix: string; max: number; count: number } | null = null
  for (const g of groups.values()) {
    if (!best || g.count > best.count || (g.count === best.count && g.max > best.max)) best = g
  }
  if (!best) return ""
  return `${best.prefix}${best.max + 1}${best.suffix}`
}

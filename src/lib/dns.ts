// DNS zone-host detection (read-only). Answers "where is this domain's DNS zone
// hosted?" — the signal a developer needs when migrating or cloning a site and
// has to inventory every domain's DNS host.
//
// No `dig` dependency: uses Node's built-in resolver (node:dns) pointed at public
// resolvers, so it works the same regardless of the machine's local DNS setup.
//
// The unit is the ZONE, not the hostname. DNS host is a property of the zone
// apex's NS records, so we WALK UP: query NS on the name; on ENODATA/NXDOMAIN
// (e.g. `www` is just a CNAME in the parent zone) strip the leftmost label and
// retry. The first label that returns NS records IS the zone apex — no Public
// Suffix List needed, and it's robust to multi-label TLDs (.co.uk).

import { Resolver } from "node:dns/promises"

export interface ZoneHost {
  apex: string // the zone apex the NS records live at (e.g. "example.com")
  nameservers: string[] // authoritative NS hostnames, lowercased + sorted
  providerKey: string // stable key for the host (e.g. "route53"); editable later: route53 | cloudflare
  providerLabel: string // human label (e.g. "AWS Route 53")
}

// Query public resolvers so results don't depend on the local resolver / VPN.
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"]

function makeResolver(): Resolver {
  const r = new Resolver({ timeout: 5000, tries: 2 })
  try {
    r.setServers(PUBLIC_RESOLVERS)
  } catch {
    // Fall back to the system resolver if the servers can't be set.
  }
  return r
}

// Lowercase, drop a trailing dot and a leading "www." — `www` is never its own
// zone, so collapsing it here means www + apex share one lookup and one cache key.
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "")
}

// The website-hosting hostnames for a set of configured site domains: each domain
// plus its sibling apex/www variant — the records that "count" in a server
// migration (apex A + www CNAME/A + each additional domain). Lowercased + deduped.
// Unlike normalizeDomain this does NOT collapse www: www is its own record here.
export function candidateHostnames(domains: string[]): string[] {
  const set = new Set<string>()
  for (const raw of domains) {
    const d = raw.trim().toLowerCase().replace(/\.$/, "")
    if (!d || !d.includes(".")) continue
    set.add(d)
    if (d.startsWith("www.")) set.add(d.slice(4))
    else set.add("www." + d)
  }
  return [...set]
}

// The next zone candidate up. Returns null once only a single-label TLD remains
// (so a dead/unregistered domain can't walk all the way up to the TLD's servers).
function parentDomain(name: string): string | null {
  const i = name.indexOf(".")
  if (i === -1) return null
  const parent = name.slice(i + 1)
  return parent.includes(".") ? parent : null
}

// Resolve the authoritative DNS host for a domain's zone. Returns null when no NS
// records can be found at or above the domain (unregistered, lookup failed, etc.).
export async function resolveZone(input: string): Promise<ZoneHost | null> {
  const start = normalizeDomain(input)
  if (!start || !start.includes(".")) return null
  const resolver = makeResolver()
  let name: string | null = start
  while (name && name.includes(".")) {
    try {
      const ns = await resolver.resolveNs(name)
      if (ns && ns.length > 0) {
        const nameservers = ns.map((n) => n.toLowerCase().replace(/\.$/, "")).sort()
        const { key, label } = labelForNameservers(nameservers)
        return { apex: name, nameservers, providerKey: key, providerLabel: label }
      }
    } catch {
      // ENODATA / ENOTFOUND / timeout → the zone is higher up; try the parent.
    }
    name = parentDomain(name)
  }
  return null
}

interface ProviderEntry {
  match: string // lowercase substring tested against each nameserver hostname
  key: string
  label: string
}

// Curated nameserver → host map for the common providers. `route53` and
// `cloudflare` are the ones a later editing phase can write to; the rest are
// label-only.
//
// PRINCIPLE: only curate a host when the NS pattern maps to ONE broadly-recognized
// brand (Cloudflare, Route 53, GoDaddy…). For white-label / reseller platforms
// where a single NS domain is resold under many brands (e.g. orderbox-dns.com →
// ResellerClub / BigRock / …), DON'T curate — the fallback's nameserver-domain
// label ("orderbox-dns.com") is the most honest, universal, and actionable signal.
// A wrong brand label is worse than the raw domain. Extend with single-brand hosts.
const PROVIDERS: ProviderEntry[] = [
  { match: "awsdns", key: "route53", label: "AWS Route 53" },
  { match: "cloudflare.com", key: "cloudflare", label: "Cloudflare" },
  { match: "domaincontrol.com", key: "godaddy", label: "GoDaddy" },
  { match: "registrar-servers.com", key: "namecheap", label: "Namecheap" },
  { match: "nsone.net", key: "ns1", label: "NS1" },
  { match: "dnsmadeeasy.com", key: "dnsme", label: "DNS Made Easy" },
  { match: "digitalocean.com", key: "digitalocean", label: "DigitalOcean" },
  { match: "ns-cloud-", key: "google", label: "Google Cloud DNS" },
  { match: "googledomains.com", key: "google", label: "Google Domains" },
  { match: "worldnic.com", key: "netsol", label: "Network Solutions" },
  { match: "dreamhost.com", key: "dreamhost", label: "DreamHost" },
  { match: "name-services.com", key: "enom", label: "eNom" },
  { match: "azure-dns", key: "azure", label: "Azure DNS" },
  { match: "wpengine.com", key: "wpengine", label: "WP Engine" },
  { match: "linode.com", key: "linode", label: "Linode" },
  { match: "vultr.com", key: "vultr", label: "Vultr" },
]

// Map a set of nameservers to a host label. Falls back to the registrable domain
// of the nameserver itself (e.g. ns1.somehost.net → "somehost.net"), so even an
// uncurated provider yields exactly the signal you'd write in an inventory.
export function labelForNameservers(ns: string[]): { key: string; label: string } {
  for (const host of ns) {
    for (const p of PROVIDERS) {
      if (host.includes(p.match)) return { key: p.key, label: p.label }
    }
  }
  const reg = registrableOf(ns[0] ?? "")
  return reg ? { key: reg, label: reg } : { key: "unknown", label: "Unknown" }
}

// Naive registrable domain (last two labels) — good enough for the fallback label
// since nameserver hostnames are almost always provider.tld style.
function registrableOf(host: string): string {
  const parts = host.replace(/\.$/, "").split(".").filter(Boolean)
  if (parts.length <= 2) return parts.join(".")
  return parts.slice(-2).join(".")
}

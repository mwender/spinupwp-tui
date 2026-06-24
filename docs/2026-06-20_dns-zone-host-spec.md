# DNS Zone-Host Inventory — Spec (v1, read-only)

The first slice of the DNS module (backlog item 6). **Read-only.** No AWS/Cloudflare
credentials, no scoped tokens, no writes. It answers one question a developer needs
exactly when migrating or cloning a site: **"where is each domain's DNS zone hosted?"**

It also proves the provider-detection layer the later editing phases will reuse, while
deliberately not touching anything dangerous.

## The job it does

When moving or cloning a site you must inventory the DNS host of every domain in the
site's portfolio — not just the apex, but separate-TLD redirects/aliases too, since a
full move has to carry the whole portfolio (and those can live on a different host).
Today that's a hand-built spreadsheet. This view replaces it.

## Core concept: the unit is the **zone**, not the site

- A site owns one or more **zones** (distinct registrable domains).
- `www.example.com` and `example.com` collapse into one zone (`example.com`).
- A separate-TLD additional domain (`example.net`) is its **own zone** with its **own
  host**, surfaced as its own row.
- DNS host is a property of the **zone apex's NS records**, so we resolve once per zone.

Per-FQDN delegation (a subdomain delegated to a different host than its apex) is a known,
bounded gap — **out of scope for v1** (no zones in the target fleet use it).

## Resolution (`src/lib/dns.ts`)

Use **`node:dns/promises`** — no `dig` dependency. Point a `new dns.Resolver()` at public
resolvers (`1.1.1.1`, `8.8.8.8`) with a timeout (~5s) to avoid local-resolver/VPN caching.

**Walk-up to find the zone apex** (no Public Suffix List needed):

```
resolveZone(domain):
  name = domain without a leading "www."
  loop:
    try ns = resolver.resolveNs(name)
    if ns non-empty -> apex = name; return { apex, nameservers: ns, ...label(ns) }
    on ENODATA/ENOTFOUND -> strip leftmost label; if <2 labels left -> return null
```

Resolvers answer NS from the closest enclosing zone, so the first label that yields NS
records *is* the apex. This is robust to multi-label TLDs (`.co.uk`) for free.

### Provider label — curated table + smart fallback

`labelForNameservers(ns: string[]) -> { key, label }`. Match any nameserver hostname
against a curated substring table; **fall back to the registrable domain of the
nameserver itself** so unknown hosts still produce the exact signal you'd write down.

Starter table (extend freely):

| NS contains            | key          | label             |
| ---------------------- | ------------ | ----------------- |
| `awsdns`               | `route53`    | AWS Route 53      |
| `cloudflare.com`       | `cloudflare` | Cloudflare        |
| `domaincontrol.com`    | `godaddy`    | GoDaddy           |
| `registrar-servers.com`| `namecheap`  | Namecheap         |
| `nsone.net`            | `ns1`        | NS1               |
| `dnsmadeeasy.com`      | `dnsme`      | DNS Made Easy     |
| `digitalocean.com`     | `do`         | DigitalOcean      |
| `ns-cloud-` / `googledomains` | `google` | Google           |
| `worldnic.com`         | `netsol`     | Network Solutions |
| `dreamhost.com`        | `dreamhost`  | DreamHost         |
| `name-services.com`    | `enom`       | eNom              |

Fallback: `ns1.somehost.net` -> `{ key: "somehost.net", label: "somehost.net" }`.

`route53` / `cloudflare` keys are the editable providers later — the inventory just
shows labels; nothing keys off editability in v1.

## Caching (`src/lib/dnsCache.ts`)

Mirror `stackCache.ts`: disk file `~/.config/spinupwp-tui/dns-cache.json`, hydrate on
startup, serialized write-through. **Keyed by zone apex** (so `www` + apex share one
entry). Value: `{ apex, nameservers, providerKey, providerLabel, checkedAt }`.

DNS host rarely changes — *except during the migration you're using this for*. So:
default staleness **24h**, but **always show age** ("checked 3m ago") and offer a
**one-key refresh** for fresh reads while watching a cutover.

## Store (`src/ui/store.tsx`)

Parallels the probe plumbing:

- `dnsZones: Map<string, ZoneHost>` — keyed by zone apex.
- `domainZone: Map<string, string | null>` — domain -> apex (or null = unresolvable).
- `dnsResolving: Set<string>` — domains in flight.
- `dnsErrors: Map<string, string>` — domain -> message.
- `lookupDomain(domain)` — resolve one (cache first), lazy.
- `lookupSiteDns(siteId)` — resolve all of a site's domains (`domain` + `additional_domains[]`).
- `lookupServerDns(serverId)` — resolve every domain of every site on the server,
  bounded concurrency 5 (like `runProbeMany`); dedupe by `www`-stripped name then by apex.
- `refreshDns(scope)` — bypass cache.

**Lazy always** — never auto-fire on selection (network cost), like `d` probe / `ensureDrift`.

## UI

### Site Detail — on-demand per-zone lines

Key **`n`** on a selected site (Browser / Servers) runs `lookupSiteDns` and adds a DNS
section to the detail pane: domains grouped by zone -> host, with a redirect note where
present.

```
DNS
  example.com    -> AWS Route 53
  example.net    -> GoDaddy           → redirects to example.com
```

### Server DNS inventory overlay (`src/ui/views/DnsInventory.tsx`)

Key **`N`** (shift) opens a full-screen overlay for the **selected site's server**
(mirrors the `d`/`D` "this site / this group" pairing; follows the Forgotten/Discover
overlay pattern). Phases: resolving (progress) -> table.

Zone-keyed table across all sites on the server:

```
SERVER  srv-name (1.2.3.4)              7 zones · 4 Route 53 · 2 Cloudflare · 1 GoDaddy

SITE              ZONE              HOST            NOTE
example.com       example.com       AWS Route 53
                  example.net       GoDaddy         → redirects to example.com
shop.example.com  shop-example.com  Cloudflare
```

- One row per distinct **zone**; `www` collapsed in.
- Separate-TLD additional domains get their own row with their own host.
- NOTE column from `AdditionalDomain.redirect` (`enabled` -> `→ redirects to {destination}`);
  a non-redirecting alias shows no note (itself meaningful).
- Summary line counts **zones** by host.
- Keys: `r` refresh (bypass cache), `Esc` close. (Sort toggle zone/host — optional.)

**No CSV export in v1.** The view replaces the spreadsheet. The data model is identical
to an export, so it's a ~half-hour add if a durable/shareable artifact need appears
(multi-day TTL migration log, client handoff).

### Discoverability

`?` Help "DNS" section + an explain/subtitle entry, per
[[feedback-name-by-outcome-teach-in-context]]. Name by outcome ("where each domain's DNS
is hosted"), not mechanism.

## Out of scope for v1 (later phases)

- Any DNS **writes** / the migrate-a-site TTL workflow (the high-risk core of item 6).
- Per-FQDN subdomain-delegation resolution.
- CSV/spreadsheet export.
- Cloudflare/Route 53 API credentials.
- A dedicated DNS/Advanced tab (overlay-first; graduate only if it accretes surfaces).

## Open implementation-level choices (recommended defaults)

- **Keys:** `n` = look up selected site; `N` = server inventory overlay (mirrors `d`/`D`).
- **Cache TTL:** 24h default staleness; age always shown; `r` forces refresh.
- **Resolver:** `node:dns` Resolver -> `1.1.1.1`,`8.8.8.8`, ~5s timeout.
- **Concurrency:** 5 (matches `runProbeMany`).

## File map

- `src/lib/dns.ts` — `resolveZone`, `labelForNameservers`, provider table, `ZoneHost`.
- `src/lib/dnsCache.ts` — disk cache (model on `stackCache.ts`).
- `src/ui/store.tsx` — maps + lazy lookup actions.
- `src/ui/views/DnsInventory.tsx` — server overlay.
- `src/ui/Details.tsx` (or the SiteDetail component) — on-demand DNS section.
- `src/ui/App.tsx` — overlay wiring + `n`/`N` keys + guards.
- `src/ui/Help.tsx` — DNS section.

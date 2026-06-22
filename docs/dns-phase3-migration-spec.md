# DNS Module Phase 3 — Migration Record Manager (writes)

The write phase of the DNS module (backlog item 6). **This is NOT a DNS zone
editor.** It is a *migration record manager*: it edits only the handful of records
that point a SpinupWP site at a server, so you can move that site to another server
safely. Everything else in the zone — MX, TXT, DKIM, service CNAMEs — is invisible
to this module and is **never touched**. That untouchability is a designed-in
feature, not a limitation (see "Safety is the product" below).

Builds on Phase 1 (`docs/dns-zone-host-spec.md`, zone-host detection) and Phase 2
(`docs/dns-access-phase2-spec.md`, access detection + the connections model).

## Why "Phase 3, re-scoped"

The first implementation (commit `bdda820`, branch `dns-phase3-ttl`) shipped TTL
editing **plus** a full-zone record list: pressing `⏎` on a record in the `N` view
opened `DnsRecords.tsx`, which listed *every* RRset in the zone and let you edit
from there. That made it a general zone editor — wider than this product needs, and
worse, it reintroduces the classic footgun the module exists to prevent: a novice
moving a site and **knocking out email** because the MX record was one keystroke
from an edit. This spec re-scopes Phase 3 around the migration job and removes the
zone-editor surface entirely.

## The job it does

When you migrate a SpinupWP site to a new server you must update the DNS records
that point the site's hostnames at the old server so they point at the new one. The
records that "count" are exactly:

- The **apex A** record (`example.com → IP`).
- **Subdomain A** records SpinupWP serves (`app.example.com → IP`).
- The **`www`** record — *only if it's its own A record*. A `www` that is a
  `CNAME → apex` follows the apex automatically and needs no edit (we mark it
  "follows apex" and de-emphasize it).
- The same set for each **additional domain** (separate-TLD aliases/redirects),
  which may live in their own zone on their own host.

Nothing else. The safe migration loop these records support:

1. **Lower TTL** on the hosting records (so propagation is fast at cutover).
2. Wait for the old TTL to expire.
3. **Repoint the target** (A value → new server IP).
4. **Verify propagation** (live authoritative values, read cred-free).
5. **Restore TTL**.

TTL editing (step 1) shipped first. Target repointing (step 3) is the next write
and reuses the same single-record edit surface — TTL and target are two fields of
one record edit, so the editor is built to hold both.

## Discovery source: SpinupWP only

Hosting records are derived **strictly** from SpinupWP's knowledge of the site —
`site.domain` + `additional_domains[]`, expanded to apex/www/subdomain candidate
hostnames (`candidateHostnames()` in `dns.ts`). We do **not** scan the zone for
stray A records that happen to point at the server IP; those are almost always
forgotten legacy records, and scanning for them would re-widen us back toward a
zone editor. SpinupWP is authoritative for what a site serves; that's our set.

## Safety is the product: "we only touch the records that move the site"

This is the differentiator, so it's enforced structurally, not by discipline:

- **No UI path shows non-hosting records.** There is no screen listing MX/TXT/etc.
  You cannot edit what you cannot reach.
- **Reads are scoped to the hosting records too** — not just writes. We never list
  the whole zone. This is achievable on every supported API (see below), so the
  guarantee holds host-agnostically and is faster besides.
- The UI states the promise in-context (per `name-by-outcome, teach-in-context`):
  the module's job is "move the site without touching anything else."

## Host-agnostic by design — same operations, per-provider implementations

We must support any DNS host that exposes an editing API, not assume Route 53. The
provider-agnostic record layer (`src/lib/dnsRecords.ts`) is the seam; its surface is
**operations on one named record**, which each provider implements its own way:

- `readHostingRecord(host, type)` → `{ value, ttl, ... }` for that one record.
- `writeHostingRecord(host, type, { ttl, value })` → upsert that one record.

The single-record scoping is supported by every major API — it is not a Route 53
convenience:

| Host | Read one record | Write one record |
| ---- | --------------- | ---------------- |
| **Route 53** | `ListResourceRecordSets` with `StartRecordName`/`MaxItems` | `ChangeResourceRecordSets` UPSERT (SigV4 POST) |
| **Cloudflare** | `GET /zones/{id}/dns_records?name=&type=` | `PATCH /zones/{id}/dns_records/{record_id}` |
| **GoDaddy / unknown** | — (no usable API for most users) | web-console handoff (`↗`) |

Cloudflare editing needs a token scoped to `Zone.DNS:Edit` (Phase 2 only required
`Zone:Read`); prompt to upgrade scope at edit time.

## Cloudflare's proxied records change the migration *semantics*, not just the API

This is the part host-agnosticism can't paper over. A Cloudflare record can be
**proxied (orange cloud)** or **DNS-only (grey cloud)**, and they migrate
differently:

- **`pointsHere` detection breaks for proxied records.** Our cred-free authoritative
  lookup (`dnsQuery.ts`) returns *Cloudflare's anycast IPs*, not your origin — so
  `◀ here` can't be computed from public DNS. For Cloudflare we may need the API
  (`DNS:Read`) just to learn where a record truly points. That reframes "access" for
  CF: web-only/no-key isn't only "can't edit," it can be "can't even show the true
  migration state."
- **The cutover move differs.** DNS-only records use the classic TTL loop
  (lower → wait → repoint → restore). **Proxied** records force TTL to "Auto"
  (TTL=1) — it's largely moot, and you cut over by changing the **origin IP**, which
  is near-instant at the edge. "Lower the TTL first" is the wrong advice there;
  there's also nothing to "restore" (Auto *is* the resting state — this is why the
  earlier note "CF automatic can't be restored yet" was a non-problem).

**Implication:** the record row must express *how this particular record cuts over*
— a TTL knob for Route 53 / DNS-only Cloudflare, an origin-swap for proxied
Cloudflare — rather than presenting one uniform TTL control.

## Editing happens in place, on one record

There is no zone drill-down. In the `N` view you select a hosting record and act on
it directly:

- The action is a **focused single-record edit** (TTL now; target/origin next),
  not a list of the zone.
- `DnsRecords.tsx` is **repurposed** from "zone browser + editor" down to "edit
  *this one record*" (it already accepts a focused target via
  `dnsRecordsTarget.focus`). Its NS-match pre-flight, confirm overlay, and
  event-tracking guts are good and reused. (If, with the zone-list gone, it still
  feels bloated, retire it for a smaller edit overlay — but start by repurposing.)

### Edit-time NS-match pre-flight (kept)

Before any write, re-dig **fresh live NS** for the zone and compare to the connected
account's hosted-zone NS (the apex NS record, free from the scoped read — no extra
`GetHostedZone` call). **Hard-stop** the edit if the account's zone isn't the one
actually serving the domain live (a red banner), and resolve which account when an
apex appears in 2+ connections. This prevents editing a stale/parked copy of a zone.

### Write plumbing (reused)

Writes go through the existing `mutate()` + async-event polling + confirm-before-
firing pattern (per CLAUDE.md), mirroring `startPhpUpgrade`: `startTtlChange` /
`ttlWrites` in the store, per-zone credential routing via `connForZone`.

## The `N` view, re-scoped

The view's spine is the two questions that matter at a server's DNS:

1. **What access do we have?** (API `✓` / web `↗` / needs-key `○`) — the Phase 2
   ACCESS column.
2. **Can we adjust TTL and (eventually) the target?** — per hosting record.

So `N` is: **per site, the handful of records that point it at a server**, each
annotated with access, current TTL, current target/value, and the `◀ here` flag
(does it point at this server?). The zone/host is lightweight *context* on those
rows — not a selectable header you drill into (there's nothing to drill into). Note
the absence of `◀ here` is also signal: a hosting record that doesn't point here
mid-migration is a discrepancy worth seeing.

This re-scoping also dissolves the "it's a bit busy" problem from a different angle
than the previous plan: the density came from carrying zone-editor scaffolding
(zone-header rows, the apex duplicated as its own record row, full column load) that
this scope no longer needs.

## Out of scope

- Any record that isn't a SpinupWP site-hosting record (MX/TXT/DKIM/service records,
  stray legacy A records).
- A general zone editor / full per-zone record list.
- Per-FQDN subdomain delegation (carried over from Phase 1).

## File map (deltas from the shipped `dns-phase3-ttl` branch)

- `src/lib/dnsRecords.ts` — keep the provider-agnostic seam; ensure reads are
  scoped to a single hostname (no whole-zone list); add Cloudflare proxied/origin
  awareness; target-write to follow.
- `src/ui/views/DnsRecords.tsx` — strip the zone record list; repurpose to a
  focused single-record editor (TTL + future target/origin).
- `src/ui/views/DnsInventory.tsx` — `N` as the whole module: hosting records with
  access + TTL + target + `◀ here`; `www`-CNAME-follows-apex distinction; per-record
  cutover hint (TTL vs origin-swap); declutter.
- `src/lib/dnsQuery.ts` — note the proxied-Cloudflare blind spot; prefer API origin
  for CF when available.
- `src/ui/store.tsx` — `startTtlChange`/`ttlWrites` (shipped); target-repoint action
  to follow; keep `connForZone` credential routing.

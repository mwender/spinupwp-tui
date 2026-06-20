# DNS Module Phase 2 — Access Detection (read-only)

Adds an **ACCESS** column to the DNS inventory: for each zone, can you edit its
DNS, and by what means? **Still no writes.** Phase 2 only *verifies read access*
(lists the zones each connected account can see) and surfaces a glyph. Editing +
the migrate-a-site TTL workflow are Phase 3.

Builds on Phase 1 (`docs/dns-zone-host-spec.md`). The zone-host detection from
Phase 1 tells us the provider; Phase 2 answers whether we hold credentials that
can reach that zone.

## The ACCESS states (glyph + footer legend)

A narrow, glyph-only column between HOST and NOTE:

| Glyph | State | Meaning |
| ----- | ----- | ------- |
| `✓` | editable | Verified: the zone apex is in a **connected** account's zone set |
| `○` | needs key | Provider is API-capable (Route 53 / Cloudflare) but the zone isn't in any connected account |
| `↗` | web only | No API path — but we can deep-link to the provider's web console |
| `·` | unknown | Unmanaged / unrecognized host (the fallback labels) |

Footer legend: `✓ editable   ↗ web only   ○ needs key`. Header `ACCESS`.

`✓` is **verified, never assumed** (user decision): we only show it when a real
`ListHostedZones` / Cloudflare list-zones response contained the zone. Creds
present but the zone not in that account → `○`, never a false green.

## Connections model — N credentials per provider

A site/dev has many accounts per provider, so a provider holds a **list of
connections**, each = one stored credential:

- **AWS connection** = one access key-set = exactly one account (no cross-account
  key; multiple accounts → multiple connections, mirroring `~/.aws` profiles).
- **Cloudflare connection** = one token, which may surface **one or several
  accounts** (a CF token can be scoped to multiple accounts / "all zones").

A provider's **effective zone set = the union across its connections.** The
ACCESS glyph asks "is this apex in that union?". Connecting another account
re-greens every zone it owns. We also record each zone's **owning account** so
Phase 3 editing can route to the right credential.

## Credentials & storage

- Stored in `config.json` (chmod 0600), a new `providers` block:
  ```jsonc
  providers: {
    cloudflare: [ { id, label, token } ],
    aws:        [ { id, label, accessKeyId, secretAccessKey, region } ]
  }
  ```
- **Env overrides** appear as read-only connections (consistent with the SpinupWP
  token): `CLOUDFLARE_API_TOKEN` → a cloudflare connection labeled "env";
  `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_REGION`) → an aws "env"
  connection. Env connections can't be removed from the UI (unset the var).
- **Never** echo a secret in a flash/log; **never** in a public artifact.
- **Least privilege is the guardrail for stored AWS keys:** the connect flow
  steers the user to a dedicated IAM user scoped to `route53:ListHostedZones` +
  `route53:ListResourceRecordSets` (Phase 2), and a Cloudflare `Zone:Read` token.

## Verification = the column's data (one mechanism)

Verifying a connection IS the fetch that powers the column:

- **Cloudflare** — `GET https://api.cloudflare.com/client/v4/zones?per_page=50`
  (paginate via `result_info.total_pages`), `Authorization: Bearer <token>`.
  Each `result[]` → `{ apex: name, accountId: account.id, accountName: account.name }`.
  Auto-label = the account name (or "N accounts" when several).
- **AWS Route 53** — hand-rolled **SigV4** GET (no `aws` CLI, no SDK):
  - `sts:GetCallerIdentity` (`https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15`,
    service `sts`) → the 12-digit account id (always permitted; auto-label default).
  - `route53 ListHostedZones` (`https://route53.amazonaws.com/2013-04-01/hostedzone`,
    service `route53`, region `us-east-1`, paginate via `IsTruncated`/`NextMarker`)
    → XML, extract each `<HostedZone>`'s `<Name>` (strip trailing dot, lowercase).
  - Both responses are XML; minimal regex extraction (no XML lib).

Results are cached on disk per connection (`providers-cache.json`, model on
`dnsCache.ts`): `{ connectionId, ok, zones: VerifiedZone[], accountLabel, error?, verifiedAt }`.
Hydrated at startup so the column populates without re-hitting providers; an age
is shown and a re-verify is one key.

## Capability registry

The Phase-1 `PROVIDERS` label table is joined by a capability map:

```ts
API_PROVIDERS = { route53, cloudflare }           // can verify via API
PROVIDER_CONSOLE: Record<providerKey, url>          // web-console deep links
  route53    → AWS Route 53 console (hosted zones)
  cloudflare → dash.cloudflare.com
  godaddy    → GoDaddy DNS manager
  namecheap, dnsme, digitalocean, google, …         // best-effort console roots
```

`accessForZone(apex, providerKey)`:
- providerKey ∈ API_PROVIDERS → apex in union(connected zones)? `editable` : `needs-key`
- else providerKey has a console → `web`
- else → `unknown`

## UI

### ACCESS column (DnsInventory)

Insert between HOST and NOTE. Glyph-only (width ~2) + the footer legend.
Empty-state teaches: with no connections, the legend reads
"connect a provider (c) to see what you can edit".

### Connect overlay (`src/ui/views/ProviderConnect.tsx`)

Opened with **`c`** on the selected zone — context-sensitive on the zone's host:
- API provider (route53/cloudflare) → the provider's connect/manage overlay
- web-only host → open its console URL (the `↗` handoff)
- unknown host → flash "no known DNS console for <host>"

The overlay is **also the per-provider manager** (honors "many accounts" without
a settings tab): it lists existing connections for that provider and an "add
another" affordance.

```
 Connect Cloudflare
   personal token        2 accounts · 18 zones · ok · 4m ago
   + add another token

 [add form]  Paste a scoped API token (Zone:Read is enough for now):
             > ********************************
             Create one at dash.cloudflare.com → My Profile → API Tokens
```

```
 Connect AWS (Route 53)
   main account (1234…6789)   12 zones · ok
   + add another account

 [add form]  Access Key ID     > AKIA…
             Secret Access Key > ****************
             Region (optional) > us-east-1
             Use an IAM user scoped to route53:ListHostedZones + ListResourceRecordSets
```

Flow: fill form → **verify immediately** → on success store the connection +
cache its zones + flash "Connected — N zones"; on failure show the error, keep
the form. Existing connection rows support **re-verify** and **remove**
(stored connections only; env connections are read-only).

### Keys

- DnsInventory: `c` = manage access for the selected zone (connect / console),
  `r` already re-runs DNS lookups — extend `r` to also re-verify connections
  (or a separate key; TBD in build).
- Connect overlay: `a` add, `↑↓` select connection, `v` re-verify, `x` remove
  (stored only), `Esc` close. Secret inputs masked.

## Store additions

- `providerConnections: { aws: Connection[]; cloudflare: Connection[] }` (config +
  env, hydrated).
- `providerZones: Map<connectionId, VerifiedConn>` (cache snapshot).
- `addConnection(provider, draft)` → verify → persist + cache; `removeConnection`;
  `verifyConnection(id)`; `verifyAllConnections()`.
- `accessForZone(apex, providerKey)` selector → `editable | needs-key | web | unknown`.
- `connectZoneTarget: { apex, providerKey } | null` (drives the overlay; set by `c`).

## Out of scope (Phase 3)

DNS record writes, TTL drop/restore migrate workflow, scope-upgrade prompts when a
read token is insufficient to edit, same per-zone credential routing for edits.

## File map

- `src/lib/awsSigV4.ts` — pure `signGetV4()` + `awsGet()` (node:crypto, fetch).
- `src/lib/providers.ts` — types, capability registry, `verifyCloudflare`,
  `verifyAws`, `accessForZone` helper, console map.
- `src/lib/providersCache.ts` — disk cache of verified zone sets.
- `src/config.ts` — `providers` block + env-derived connections.
- `src/ui/store.tsx` — connections state + actions + `accessForZone`.
- `src/ui/views/ProviderConnect.tsx` — connect/manage overlay.
- `src/ui/views/DnsInventory.tsx` — ACCESS column + `c`.
- `src/ui/App.tsx`, `src/ui/Help.tsx` — wiring + docs.

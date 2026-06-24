# Clone a Site to a New Server — spec

Backlog item 5. This is the app's largest write feature: it provisions real
infrastructure and performs the DNS cutover that moves a live site between
servers. It composes everything built so far — the write-mode scaffolding
(`mutate()`/`getEvent`), the SSH/WP-CLI orchestration from the DB tooling, the
deep-link handoff pattern, and the DNS module — into one guided, resumable
workflow.

Builds on: the write scaffolding from PHP upgrade (item 8), the SSH staging
helpers in `src/lib/dbBackup.ts` / `src/lib/dbSync.ts` (item 11), the `#sftp`
deep-link handoff (item 7 / item 5 SSH-key mitigation), and the DNS module
(`docs/2026-06-20_dns-zone-host-spec.md`,
`docs/2026-06-20_dns-access-phase2-spec.md`,
`docs/2026-06-22_dns-phase3-migration-spec.md`).

## The product

> "Stand up a new server, copy this site onto it, prove the copy works over real
> HTTP, then flip DNS — without me hand-running ten SSH commands and a DNS console."

There is **no clone/duplicate endpoint** in the SpinupWP API (verified). So this
is an *orchestration* over three layers: API writes (create server, create site,
nothing else), SSH + WP-CLI (the actual file/DB copy and verification), and DNS
provider writes (the cutover). The whole point is that the app sequences and
gates these for you, applying confirm-before-prod-writes hard at the two moments
that cost money or take a site down (server creation, DNS cutover).

MVP scope (user, 2026-06-24): clone an existing site to a **brand-new** server.
Cross-server is the explicit target — not same-server, not "pick an existing
server." Server creation is built as a **standalone action the wizard reuses**,
not wizard-only.

## Why a resumable wizard, not an overlay

Every existing overlay (`PhpUpgrade`, `DbSync`, `MediaFallback`) is one action:
confirm → run → done, and its progress lives in the store so it survives closing
the modal. This feature is **seven chained actions** spanning minutes to the better
part of an hour (server provisioning alone averages ~10 min per SpinupWP's docs).
You must be able to fire it, press `esc`, go do other things, and come back to a
still-advancing job.

So the unit of state is a single store-resident **`CloneJob`**, and the overlay is
just a view onto it (same principle as `dbSyncs`/`phpUpgrades`, generalized):

```ts
type CloneStep =
  | "plan" | "server" | "sshgate" | "site"
  | "copy" | "verify" | "dns" | "done" | "error"

type CloneJob = {
  sourceSiteId: number | null      // null = standalone "create server" entry
  step: CloneStep
  failedStep?: CloneStep
  error?: string

  // captured inputs
  specs: { providerName: string; region: string; size: string; cost?: number }
  serverName: string
  vanity: boolean
  lowerTtlEarly: boolean

  // created resources
  destServerId?: number
  destServerIp?: string
  destSiteId?: number

  // live sub-progress for long-running steps (reuses StepRow shape)
  copy?: StepRow[]
  verify?: VerifyResult
}
```

`cloneJob: CloneJob | null` is the overlay-visibility field (set non-null →
overlay renders, App.tsx keyboard early-returns). Polling and SSH orchestration
run in `store.startClone()` / `advanceClone()` — fire-and-forget, exactly like
`startPhpUpgrade`/`startDbSync` — so closing the overlay never abandons work.

## API findings (verified 2026-06-24 against api.spinupwp.com)

**Pricing is available** — the cost line the user wanted is fully backed:
`GET /providers/{provider}/metadata` (providers: `digitalocean`, `vultr`,
`linode`, `hetzner`) returns:

```jsonc
{
  "regions": { "<Continent>": [ { "slug", "name", "available", "continent", "sizes": ["<size_slug>"] } ] },
  "sizes":   [ { "slug", "type", "memory", "vcpus", "disk", "transfer",
                 "priceMonthly", "backupPriceMonthly", "available", "processor" } ]
}
```

`priceMonthly` + `backupPriceMonthly` give us the monthly cost; `regions[*].sizes`
tells us which sizes a region offers. We resolve the source server's `size`/`region`
(from the typed `Server` object) against this to show "match source" with a price.

**Create server** — `POST /servers`, async → returns `{ event_id }` + the Server:

```
server_provider[id] | server_provider[name] + server_provider[api_token]   (one approach)
server_provider[region]        (required, slug)
server_provider[size]          (required, slug)
server_provider[enable_backups](optional bool)
hostname                       (required; alphanumeric/dashes/periods — IS the server name)
timezone                       (optional, default UTC)
database[root_password]        (optional, auto-gen if blank)
database_provider[id]          (optional, external DB)
post_provision_script          (optional, runs as root)
```

Note `hostname` is the server name (`web12.example.com`) — the same string we
optionally reuse as the vanity site's domain.

**Create site** — `POST /sites`, async → `{ event_id }` + Site. Required:
`server_id`, `domain`, `site_user`, `installation_method`. The destination for a
clone uses **`installation_method: "blank"`** (options are
`wp | wp_subdirectory | wp_subdomain | git | blank`) — a site with **no WP files
scaffolded**, which is exactly what we want before dropping the source's files in.
Relevant optional fields:

```
php_version            (default 8.3 — we MATCH the source's php_version)
public_folder          (default "/" — we MATCH the source's public_folder)
database[name|username|password|table_prefix]    (we set table_prefix to match source)
page_cache[enabled]
```

The WordPress block (`wordpress[title|admin_user|admin_password|admin_email]`) is
only needed for the `wp*` methods; with `blank` it's irrelevant. **Open empirical
question:** whether `blank` provisions a database on its own, or whether we must
pass the `database[...]` block to force one. Either way we pass `database[...]`
with `table_prefix` matched to the source — so the destination DB exists and the
imported dump's table names line up. Verify on the first real run.

## The journey (two-pane wizard)

User chose the **two-pane / journey-rail** layout: a fixed left rail (~22 cols)
always shows the seven steps as a `StepRow` checklist (`✓ / ⠹ / ○ / ✕`) plus a
`src → dest` context footer, so you never lose your place across a long flow. The
right pane is the active step, rendered in one of the three modes the app already
uses: **input** (form), **confirm** (the prod-write gate), or **running** (a live
`Steps` checklist).

```
┌ Clone → new server ──────────────────────────────┐
│ JOURNEY            │  New server                   │
│ ✓ Plan             │  Match source: hetzner1       │
│ ⠹ New server       │  Provider  Hetzner            │
│ ○ SSH key          │  Region    ash (Ashburn)      │
│ ○ Create site      │  Size      CPX21 2vCPU/4GB    │
│ ○ Copy files+DB    │  Cost      ~$8.49/mo          │
│ ○ Verify           │                               │
│ ○ DNS cutover      │  Name web12.example.com▏      │
│ src: example.com   │  [e]dit  [enter] next         │
└────────────────────┴───────────────────────────────┘
```

### 1. Plan

Read-only review + pre-flight. Shows the source site's specs (server, provider,
region, size, `php_version`, `public_folder`, WP yes/no) and what the clone will
do. Pre-flight gates: `✓` SSH reachable to the **source** server (BatchMode probe,
reuse `ssh.ts`), `✓` token is Read/Write (a 403 here means stop — surface the same
"token is read-only" message `mutate()` raises). Two opt-in toggles:

- **Lower DNS TTL now** — drop the apex/www A-record TTL to 60s *at the start* of
  the job. Provisioning burns ~10 min anyway; by cutover the low TTL has
  propagated, so the switch is near-instant instead of waiting out an old long
  TTL. Requires DNS write access to the zone (reuse the access detection); if the
  zone isn't editable we grey the toggle and note the manual fallback. Restored
  to the original TTL after a successful cutover.
- **Create a vanity site** — see step 4.

### 2. New server (also the standalone entry point)

Input → confirm → long-running. Defaults to **match source** (provider/region/size
resolved against `providers/{provider}/metadata`), with `e` to edit
provider/region/size from the metadata lists. Renders the **cost** line from
`priceMonthly` (+ `backupPriceMonthly` if backups toggled). A `hostname`/name
input pre-filled by **fleet-pattern auto-suggest**: read existing server names,
detect a `web{N}` / `{provider}{N}` sequence, suggest the next (`web12.…`) —
generalizes to any naming convention without hardcoding the user's. Hard confirm
("creates a new {size} in {region}, ~${cost}/mo — proceed?") →
`client.createServer(...)` → poll `getEvent(event_id)` until provisioned. The rail
shows `⠹ New server`; the job keeps polling if the overlay is closed. On success,
capture `destServerId` + `destServerIp`.

Standalone use: same screen, started with `sourceSiteId: null`; on success it ends
the job at `done` (no clone steps).

### 3. SSH-key gate — the load-bearing checkpoint

The API **cannot** provision the user's SSH key onto the new server (verified —
`GET /ssh-key` returns only SpinupWP's provisioning key; no key field in create
payloads). But steps 5–6 *are* SSH into that new box. So the wizard stops here:

> "Your key isn't on `web12.example.com` yet. `w` opens SpinupWP's SSH/SFTP
> panel; press `r` to retry the connection."

`w` → `siteWebUrl(destSiteId, slug) + "#sftp"` (the confirmed real fragment, once
the site exists) or the server panel before then; `r` runs a BatchMode SSH probe
against `site_user@destServerIp`. Advances only when the probe succeeds. This is a
hard dependency, not a nicety — every later step needs this connection.

### 4. Create site

`POST /sites` with `installation_method: "blank"`, `public_folder` and
`php_version` matched to source, `database[table_prefix]` matched, `domain` =
source domain (the new site carries the *same* domain — DNS still points at the old
server, so there's no temporary hostname and no URL search-replace needed for the
move itself). Confirm → poll. Capture `destSiteId`.

If **vanity site** was chosen in step 1, it's created here too: a second
`POST /sites` with `domain` = the server `hostname` (`web12.example.com`),
`installation_method: "blank"`, then an `index.php` dropped via SSH carrying the
WHMCS-style server-status / uptime output. (The exact uptime payload is a
user-supplied detail — scaffold the file write now, fill the metrics body when the
user provides the WHMCS contract. Keep it a single self-contained `index.php`.)

### 5. Copy files + DB

Running step, server → **relay through the local machine** → server. Direct
server-to-server scp would need the new box to trust the old box's key, which we
just established we can't provision; the local machine can already reach both, so
we relay (`scp -3` / tar-pipe through local). The user's zip-first instinct is
correct and matches the DB tooling's proven staging pattern. Sub-steps (rendered
as a `Steps` checklist with `failedStep` marking the break point):

1. **Export source DB** — SSH `wp db export` + `gzip` into `$HOME` (outside
   webroot — never stream the dump; plugin stdout noise corrupts it. Same gotcha
   as `dbBackup.ts`).
2. **Relay DB** — pull dump to a local temp, push to dest `$HOME`.
3. **Import dest DB** — `gunzip | wp db cli` on dest.
4. **Archive source files** — `tar czf` the webroot, excluding caches and
   (configurably) very large uploads dirs.
5. **Relay files** — pull archive local, push to dest.
6. **Extract on dest** — untar into the dest webroot.
7. **Fix config/creds** — the destination is a `blank` SpinupWP site with its
   **own** DB credentials and salts. Importing source files would clobber the
   working `wp-config.php` (Standard WP) / `.env` (Bedrock). So preserve the dest's
   DB creds + salts: either skip overwriting the config file during extract, or
   re-stamp dest creds after extract. Domain stays the same, so no
   `search-replace` for the move; only run it if a domain actually changes.

All SSH/scp via the shared `SSH_OPTS`/`runProcess`/`meaningfulError` helpers;
errors are stage-prefixed; `failedStep` set on the broken sub-step.

### 6. Verify

The user assumed this couldn't be a real HTTP test "over the production URL." It
**can** — we know the new IP, so we test the live site on the new box without
touching DNS:

```
curl --resolve example.com:443:<NEW_IP> -sS -o /dev/null -w '%{http_code}' https://example.com
```

That hits the real new server, TLS and vhost and all, while DNS still points at the
old one. Combined with WP-CLI checks over SSH and a **source-vs-clone diff**:

| check                     | source | clone |
|---------------------------|--------|-------|
| `wp core version`         | 6.x    | 6.x   |
| `wp db check`             | ok     | ok    |
| active plugins (count/list)| n     | n     |
| active theme              | …      | …     |
| `home` / `siteurl`        | …      | …     |
| live HTTP (`--resolve`)   |  —     | 200   |

Green across the board enables `enter → proceed to DNS`; a mismatch blocks and
explains. (`wp core verify-checksums` optional.)

### 7. DNS cutover

The scary one — confirm-before-prod-writes at its hardest. Reuse the DNS module's
zone resolution + the **edit-time NS-match pre-flight** (re-dig fresh authoritative
NS, one `GetHostedZone` for the chosen account, hard-stop if the account's zone
isn't actually live — see the Phase 3 migration spec). Then **repoint** the apex A
+ `www` (if it's its own A record) + additional-domain A records from the old IP to
`destServerIp`. Final propagation check via the same `--resolve`-free read of live
authoritative values; on success, restore the TTL if we lowered it in step 1.

This requires **DNS record-value editing**, which does not exist yet — the module
only edits TTL today (`dnsRecords.ts` has `setTtl`, not value editing). We add
`setRecordValue` (Route 53 UPSERT echoing the record with the new IP; Cloudflare
PATCH `content`) — the editor was already built to hold both TTL and target as two
fields of one record edit (noted in the Phase 3 spec), so this is the planned
extension, not a detour.

## Files

**New**
- `src/ui/views/CloneWizard.tsx` — the two-pane overlay (journey rail + per-step
  right pane).
- `src/lib/serverCreate.ts` — create-server / create-site flows + the
  `providers/{provider}/metadata` fetch + cost/size/region resolution + fleet
  name auto-suggest.
- `src/lib/serverClone.ts` — the SSH copy + verify orchestration (built on
  `dbBackup.ts` helpers).

**Extend**
- `src/api/client.ts` — `createServer()`, `createSite()`, `providerMetadata()`.
- `src/lib/dnsRecords.ts` — `setRecordValue()` (IP repoint) for Route 53 +
  Cloudflare.
- `src/ui/store.tsx` — the `cloneJob` slice (`startClone`, `advanceClone`,
  per-step polling, copy/verify progress).
- `src/ui/App.tsx` — overlay registration + keyboard early-return.
- `src/ui/views/Browser.tsx` / `Search.tsx` — launch keys (TBD; check collisions:
  candidate `c` = clone-this-site, a standalone "new server" key from the Servers
  tab). `src/ui/Help.tsx` lines.

## Build sequence (each independently shippable / testable)

1. `providerMetadata()` + the **New-server screen as the standalone action**
   (create a server, with cost + name suggest + confirm). First real
   `POST /servers`. Smallest end-to-end write; validates pricing + provisioning
   poll.
2. The **wizard shell** (two-pane, `CloneJob` state, journey rail, plan +
   SSH-gate steps) wrapping step 1.
3. **Create site** (`blank`) + the vanity-site option.
4. **Copy** orchestration (`serverClone.ts`).
5. **Verify** (WP-CLI diff + `--resolve` HTTP).
6. **DNS cutover** (`setRecordValue` + reuse the migration pre-flight) — last and
   riskiest.

## Safety

- Two hard confirms gate the only irreversible/charged actions: **server creation**
  (costs money) and **DNS cutover** (moves live traffic). Everything between is
  additive (a new server + new site that nobody points at yet) and safe to abandon.
- The clone never mutates the **source** — it only reads (DB export, file archive,
  WP-CLI reads). The source keeps serving until the user pulls the DNS trigger.
- Token-scope: a 403 on any write surfaces the existing read-only message; the read
  path is never broken.
- The new server's DB root password / site DB creds are SpinupWP-generated or
  app-passed and never printed.

## Open questions

1. **`blank` + database** — does `blank` auto-create a DB, or must we pass
   `database[...]`? (We pass it regardless with matched `table_prefix`; confirm
   behavior on first run.)
2. **Config preservation on extract** — skip-overwrite vs re-stamp creds for
   `wp-config.php` (Std WP) and `.env` (Bedrock). Decide per stack via
   `findProjectRoot`.
3. **Vanity uptime payload** — the WHMCS-style server-status `index.php` body
   (user to supply the exact metric contract).
4. **Large-uploads handling** — exclude huge uploads from the tar and lean on the
   media-fallback mu-plugin (item 12) instead? Reasonable default for big media
   libraries; make it a copy-step option.
5. **Launch keys** — confirm free keys in Browser/Search/Servers contexts.

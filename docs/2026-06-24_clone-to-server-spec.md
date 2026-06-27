# Clone a Server to a New Server — spec

Backlog item 5. **Revised 2026-06-26** from a single-site clone to a true *server*
clone: stand up a new server and move **all of a source server's sites** (1 to
many) onto it in one guided, resumable pass, then flip DNS. This is the app's
largest write feature — it provisions real infrastructure and performs the DNS
cutover that moves live sites between servers.

It composes everything built so far: the write scaffolding (`mutate()`/`getEvent`),
the **sudo-over-SSH connector** and **grant-key-to-every-site-in-one-pass** shipped
this branch, the SSH/WP-CLI orchestration from the DB tooling, the deep-link
handoff, and the DNS module — into one workflow.

Builds on: the write scaffolding from PHP upgrade (item 8), the
**sudo SSH provisioning** (`docs/2026-06-26_sudo-ssh-key-provisioning-spec.md`;
`src/lib/ssh.ts`, `src/ui/views/SudoConnect.tsx`, `src/ui/views/GrantKey.tsx`), the
server-create flow (`src/ui/views/NewServer.tsx`, `src/lib/serverCreate.ts`), the
vanity-site bootstrap (`docs/2026-06-25_vanity-site-spec.md` — the "connected but
empty" dead-end and its fix), the SSH staging helpers in `src/lib/dbBackup.ts` /
`src/lib/dbSync.ts` (item 11), and the DNS module
(`docs/2026-06-22_dns-phase3-migration-spec.md`, `src/lib/dnsRecords.ts`).

## The product

> "Stand up a new server, copy **every site** off this old one onto it, prove each
> copy works over real HTTP, then flip DNS for all of them — without me hand-running
> a hundred SSH commands and a DNS console."

There is **no clone/duplicate endpoint** in the SpinupWP API (verified). So this is
an *orchestration* over three layers: API writes (create server, create sites,
nothing else), **SSH + WP-CLI run server-to-server** (the actual file/DB copy and
verification), and DNS provider writes (the cutover). The app sequences and gates
these, applying confirm-before-prod-writes hard at the two moments that cost money
or take sites down (**server creation**, **DNS cutover**).

MVP scope (user, 2026-06-24, revised 2026-06-26): clone an existing server's sites
to a **brand-new** server. Cross-server is the explicit target — not same-server,
not "pick an existing server." Server creation is built as a **standalone action
the wizard reuses**, not wizard-only.

## What "all sites" changes — the core of this revision

The original spec moved one site and relayed its tar+DB **through the local
machine**, because the new box couldn't be made to trust the old one. Two things
killed that constraint:

1. **It's a server, so it's 1–N sites.** Relaying N webroots + N dumps through a
   residential uplink is the wrong architecture — the bytes should go
   datacenter-to-datacenter.
2. **We now have sudo-over-SSH** (this branch). The local machine becomes the
   **conductor, not the pipe**: it issues SSH commands; the dest server **pulls**
   each site directly from the source.

So the model is now:

- **Sudo on both ends.** Spinup's privileged access is a **session sudo connection**,
  exactly as built (`SudoConnect`): you create a SpinupWP **sudo user** on a server
  (your standing convention on every new box) and authenticate Spinup with its
  username + sudo password, held **in memory for the session only** — nothing is
  injected or persisted. We need one on the **source** (root → read any site's files
  + `wp db export`) and one on the **dest** (root → write any site's webroot + `wp db
  import`). A sudo user is *server-level*, independent of sites — so a brand-new
  **0-site** dest can be sudo-connected immediately. (This is *not* the vanity spec's
  per-site-key bootstrap; that constraint was about site users for SSH keys and
  doesn't apply to sudo.)
- **Pull path (decided — see Connect dest).** With root on both ends, the per-site
  copy runs server-side and the dest **pulls** from the source, logging in *as the
  source site user*. The dest authenticates with a **granted key** (its own key,
  added to the source site user and revoked at job end), with **agent forwarding as a
  per-site fast-path** that skips the grant when your key already reaches that site
  user.
- **Pull, concurrently.** Each site is created `blank` on the dest, then a per-site
  clone script runs **on the dest** (under sudo) and **pulls** that site's DB and
  files straight from the source over the trusted hop. Sites run **concurrently,
  capped at 3** (the cap protects the *source*'s I/O while it's still serving live
  traffic — see Throttle).
- **Cutover batched at the end.** Clone every site first; then one deliberate,
  partial-aware DNS flip moves them all.

### Pull, not push (decided 2026-06-26)

The dest **pulls** from the source (dest-initiated `rsync` / `wp db export | wp db
import` over SSH). Rationale: all orchestration scripts then run on the **throwaway
dest box** (easy to reason about, nothing left on the source). The auth direction
this implies — dest must authenticate *into* source — is the one genuinely open
mechanism (see Connect dest): agent-forward your key, or grant a dest-held key onto
the source.

## Why a resumable wizard, not an overlay

Every existing overlay (`PhpUpgrade`, `DbSync`, `MediaFallback`) is one action:
confirm → run → done. This is **five server-level steps wrapping an N-wide
per-site fan-out**, spanning minutes to the better part of an hour (provisioning
alone averages ~10 min). You must be able to fire it, press `esc`, go do other
things, and come back to a still-advancing job — and have it survive a quit.

So the unit of state is a single store-resident **`CloneJob`** whose heavy work
lives in a **per-site state vector**, and the overlay is just a view onto it (same
principle as `dbSyncs`/`phpUpgrades`/`vanityJob`, generalized to a fleet).

```ts
type CloneStep =
  | "plan" | "server" | "trust" | "clone" | "cutover" | "done" | "error"

type CloneSiteStep =
  | "create" | "pull" | "config" | "deploy" | "verify" | "done" | "error"
  // "deploy" is Bedrock-only (POST /sites/{id}/git/deploy after seeding auth.json/.env)

interface CloneSiteState {
  sourceSiteId: number
  domain: string
  selected: boolean              // unchecked in Plan → skipped entirely
  sizeBytes?: number             // webroot + DB estimate (sizing + progress)
  stack: "wp" | "bedrock"        // from source git.repo → drives blank-vs-git create
  excludeUploads: boolean        // per-site opt-out (default false = sync uploads/)

  destSiteId?: number
  step: CloneSiteStep
  failedStep?: CloneSiteStep
  error?: string
  pull?: StepRow[]               // db / files sub-progress (reuses StepRow)
  verify?: VerifyResult

  // populated in the cutover phase
  zone?: { name: string; provider: string; account?: string; editable: boolean }
  cutover?: "pending" | "editable" | "manual" | "skip" | "done" | "error"
}

interface CloneJob {
  sourceServerId: number
  step: CloneStep
  failedStep?: CloneStep
  error?: string

  // captured inputs
  specs: { providerName: string; region: string; size: string; cost?: number; enableBackups?: boolean }
  destServerName: string
  concurrency: number            // default 3
  lowerTtlEarly: boolean

  // created resources
  destServerId?: number
  destServerIp?: string
  // only when the pull uses a granted key (vs agent forwarding) — for end-of-job revoke
  pullKey?: { fingerprint: string; grantedSiteIds: number[] }

  // the fan-out
  sites: CloneSiteState[]
}
```

`cloneJob: CloneJob | null` is the overlay-visibility field. Polling and SSH
orchestration run in `store.startClone()` / `advanceClone()` — fire-and-forget,
exactly like `startPhpUpgrade`/`startVanity` — so closing the overlay never
abandons work. `advanceClone()` **reduces over `sites`** rather than following a
single pointer: each in-flight site is driven independently, up to `concurrency` at
once.

## Resumable jobs (shared mechanism)

`CloneJob` adopts the shared **resumable-job registry** (config-persisted, resumes
on restart) defined here originally and now live: `config.json` `jobs` map,
`saveJob`/`removeJob`/`isJobInFlight` (`src/lib/jobs.ts`), the single
`pollEvent`-style loop, and mount-time hydration that dispatches by `kind`.

The honest hard part is **multi-step + multi-site resume**. Steps split three ways:

- **Event-backed** (server create, each site create, each HTTPS/DNS event) — true
  resume by re-attaching the stored `eventId`.
- **SSH-orchestrated** (the per-site pull) — no SpinupWP event to re-attach to, so
  resume means **idempotent, state-checking runners**: on resume, `advanceClone()`
  re-enters per site at `site.step` and each runner first *detects* whether its work
  landed (does the dest site exist? is the DB already imported? files present?)
  before redoing it. Same constraint dbSync hit; here it's per-site.
- **Manual** — the **Connect dest** sudo handoff (you create the sudo user in
  SpinupWP, then authenticate Spinup) and the **cutover** confirm both wait on you.

Because the unit is a `sites[]` vector, a restart knows site 1–5 are `done`, 6 is
`error`, 7–8 never started — and picks up exactly there.

## API findings (verified 2026-06-24 against api.spinupwp.com)

**Pricing is available** — `GET /providers/{provider}/metadata` (providers:
`digitalocean`, `vultr`, `linode`, `hetzner`) returns `regions{}` + `sizes[]` with
`priceMonthly` + `backupPriceMonthly`. We resolve the source server's `size`/`region`
against this to show "match source" with a price, and use `sizes[].disk` for the
sizing check (below).

**Create server** — `POST /servers`, async → `{ event_id }` + Server. Key fields:
`server_provider[id|name+api_token]`, `server_provider[region]` (slug),
`server_provider[size]` (slug), `server_provider[enable_backups]`, `hostname`
(required; **is** the server name), `timezone`, `database[root_password]`,
`post_provision_script` (optional, runs as root — **not used** for the foothold; our
sudo access is user-provisioned via `SudoConnect`, see step 3).

**Create site** — `POST /sites`, async → `{ event_id }` + Site. Required:
`server_id`, `domain`, `site_user`, `installation_method`
(`wp | wp_subdirectory | wp_subdomain | git | blank`). The `wp*` methods *install a
fresh WordPress* — not what we want. So we use, per source stack:

- **Standard WP → `blank`** (no files scaffolded; we pull the source's webroot in).
- **Bedrock / git → `git`**, passing the source's `git[repo|branch|deploy_script|
  push_enabled]` so the dest is a deployable Bedrock site, not a file copy. The source
  `Site.git` already carries these (`src/api/types.ts`), but **`CreateSitePayload`
  currently has no `git` block — extend it** and confirm the API accepts git params on
  create (the SpinupWP docs list them).

Either way we MATCH the source's `php_version`, `public_folder`, and
`database[name|username|password|table_prefix]` (so the dest DB exists and imported
table names line up). The `wordpress[...]` block is irrelevant for `blank`/`git`.

**Run a git deployment** — `POST /sites/{id}/git/deploy`, async → `{ event_id }`
([docs](https://api.spinupwp.com/#run-a-git-deployment)). This is how we re-deploy a
Bedrock site *after* seeding `auth.json` + `.env` (the first deploy at create time is
expected to fail without them).

**Open empirical questions:** (a) whether `blank` provisions a database on its own or
we must pass `database[...]` (we pass it regardless, matched `table_prefix`);
(b) whether a `git`-created site accepts our `git[...]` + `database[...]`. Confirm both
on the first real run. (Deploys never touch the gitignored `.env`, so re-stamping it
needs no special sequencing.)

## The journey (two-pane wizard — Journey Rail)

A fixed left rail (~22 cols) always shows the **five server-level steps** as a
`StepRow` checklist plus a `src → dst` context footer, so you never lose your place.
The two heavy steps carry an **N-fraction badge** and **expand into a per-site
roster** in the right pane (sites as rows, sub-steps as columns). The rail stays
five rows whether you move 1 site or 30 — and with a single site the roster is one
row, degrading cleanly to the old single-site shape.

```
┌ Clone hetzner1 (8 sites) → new server ──────────────────────────────┐
│ JOURNEY              │  Clone sites · running 3 at once               │
│                      │                                                │
│ ✓ Plan               │  SITE                  db      files   cfg  ✓  │
│ ✓ New server         │  example.com           ✓       ✓       ✓    ✓ │
│ ✓ Connect dest       │  shop.example.com       ✓       ⠹ 64%   ○    ○ │
│ ⠹ Clone sites  2/8   │  blog.example.com       ⠹       ○       ○    ○ │
│ ○ DNS cutover  0/8   │  cdn.example.com        ⠹       ○       ○    ○ │
│                      │  docs.example.com       ○ queued                │
│ ──────────────────   │  … +3 queued                                   │
│ src  hetzner1 · 8    │                                                │
│ dst  web14 · 5.161…  │  ✓ 2 done · ⠹ 3 running · 3 queued              │
│ ⠹ ~6m left (slowest) │  r retry · ⏎ inspect site · esc background      │
└──────────────────────┴────────────────────────────────────────────────┘
```

Right-pane modes per step: **input** (form), **confirm** (the prod-write gate),
**running** (a `Steps` checklist or the per-site roster).

### 1. Plan — select sites + size the dest

Read-only review + pre-flight + **the two choices "all sites" forces**:

- **Which sites to bring.** A checklist of the source server's sites, **default all
  selected**. Deselect staging/parked/junk domains. Drives sizing and the fan-out.
- **Dest sizing.** "Match source" sizes the *box*; the *payload* is the sum of
  selected sites' webroot + DB. Plan sums it and checks it against the matched
  size's `disk`, warning if it won't fit.

```
│ ✓ Plan               │  Bring which sites?            7 of 8 selected  │
│                      │   ◉ example.com         2.1 GB                  │
│                      │   ◉ shop.example.com    9.4 GB  ← largest       │
│                      │   ◯ staging.example.com 0.3 GB  (skipped)       │
│                      │   ◉ blog.example.com    1.2 GB                  │
│                      │   …                                             │
│                      │  Payload ~24 GB · CPX41 disk 240 GB ✓ room      │
│                      │  space ↑↓ · ⏎ continue                          │
```

Pre-flight gates (block continue): `✓` token is Read/Write (a 403 → stop with the
existing read-only message), `✓` **sudo reachable on the source** (we must be able
to grant the dest key onto source sites, and to read each site as its user). If
sudo to the source isn't connected, offer `SudoConnect` inline (same overlay the
vanity flow layers).

Two opt-in toggles:

- **Lower DNS TTL now** — drop the apex/www TTLs to 60s *at the start*. Provisioning
  + cloning burns the propagation wait for free, so cutover is near-instant.
  Requires DNS write to each zone; greyed per-zone where not editable. Restored
  after a successful cutover.
- (Vanity site for the new box is **out of scope** here — that's its own action; a
  clone target's hostname doesn't need a placeholder because it gets real sites.)

### 2. New server (also the standalone entry point)

Input → confirm → long-running. Defaults to **match source** (provider/region/size
resolved against `providers/{provider}/metadata`), `e` to edit. Renders the **cost**
line. `hostname`/name pre-filled by **fleet-pattern auto-suggest** (read existing
names, detect a `web{N}` / `{provider}{N}` sequence, suggest the next).

Just provisioning — **no key injection**. (`post_provision_script` exists and runs as
root, but our sudo model is *user-provisioned*, not script-injected: you create the
sudo user in SpinupWP and authenticate Spinup to it. That's the next step.)

**Hard confirm** ("creates a new {size} in {region}, ~${cost}/mo — proceed?") →
`client.createServer(...)` → poll until provisioned → capture `destServerId` +
`destServerIp`. The rail shows `⠹ New server`; the job keeps polling if the overlay
is closed.

Standalone use: same screen, started with `sourceServerId: null` and no `sites`; on
success it ends the job at `done` (no clone steps) — the reusable "create a server"
action.

### 3. Connect dest — the privileged foothold (your turn)

The load-bearing checkpoint, and a **manual handoff** (matching how sudo actually
works in Spinup). A freshly-created server has no sudo user yet, so:

1. **Create a sudo user on the new server** — a deep-link handoff into SpinupWP (the
   server's sudo-users page), your standing convention. No API for this — same reason
   the SSH-key grant is sudo-over-SSH.
2. **Authenticate Spinup** — the `SudoConnect` overlay: enter the new sudo user +
   password; Spinup validates against the live box and holds the creds **in memory
   for the session**. The rail row sits at amber `❯ your turn` until this lands.
3. **Confirm source sudo** — Plan already required a sudo connection to the
   **source**; re-verify it's still live (root there is how we read each site).

With both ends connected, the wizard can run the server-side pull. This is **distinct
from the sudo foothold above**: the sudo connection is *yours* (how Spinup gets root
on each box); the pull auth below is *how the dest reaches the source*.

**Pull auth — decided 2026-06-26: granted key as the mechanism, agent forwarding as a
per-site fast-path.** The key requirement is that the dest logs into the source **as
the site user** (so `wp db export` + file reads "just work" — the site user owns its
own webroot, no source-side sudo in the pull path). Per source site:

1. **Probe forwarding first.** Spinup drives the dest with `-A`; test whether *your*
   forwarded key already logs into that source **site user**. If it does → use it,
   **skip the grant** (zero residue — the simple case). This works only when your key
   is already on that site user's `authorized_keys`; it never leaves your machine.
2. **Otherwise grant a key.** Generate a keypair on the dest and grant *its* public
   key onto that source site user in one pass via the shipped grant-key flow (survives
   reconcile — `docs/2026-06-26_sudo-ssh-key-provisioning-spec.md`); record it in
   `pullKey`. **Revoked at job end** (no-op for sites that used forwarding).

Why granted-key is the floor, not forwarding: forwarding carries two environmental
assumptions — a live local `ssh-agent` holding your key, *and* your key already being
on each source **site user** (precisely the gap the grant feature exists to fill; if
it's only on the *sudo* user, forwarding would fall back to sudo-escalating on the
source, dragging the source sudo password into server-side commands). Granted-key has
neither dependency and reuses code we already trust, so worst case is always
grant+revoke, which works. The forwarding fast-path simply *skips* the grant when your
key already reaches the site user.

### 4. Clone sites — concurrent, server-side pull (the fan-out)

The roster macro-step. Each **selected** site runs an **independent** chain, with up
to **`concurrency` (default 3)** in flight at once; the rest queue. A failed site
**does not block** the others — it sits at `✕` while the rest flow, and you retry
just that one (`r`). Per-site chain (roster columns):

The chain **branches by stack**, detected from the source `Site`: `git.repo` set →
Bedrock/git; otherwise Standard WP.

1. **create** — `POST /sites`, `domain` = source domain (DNS still points at the old
   server → no temporary hostname, no URL search-replace), `php_version` /
   `public_folder` matched, and `database[name|username|password|table_prefix]` set so
   the dest DB exists with matching table names. Poll → capture `destSiteId`.
   - **Standard WP** → `installation_method: "blank"` (empty docroot we pull files
     into).
   - **Bedrock / git** (source `git.repo`) → `installation_method: "git"`, carrying
     the source's `git[repo|branch|deploy_script|push_enabled]`, so the dest is a
     **real deployable Bedrock site wired to the same repo + CI** — not a dead file
     copy. SpinupWP clones the repo and runs the deploy script; this **first deploy is
     expected to fail** (no `auth.json`/`.env` yet — normal, see Bedrock deploy
     ordering). (Requires **extending `CreateSitePayload` with a `git` block** — verify
     the API accepts git on create; see API findings.)
2. **pull** — the dest pulls **as the source site user** (no source sudo in the path),
   server-to-server, no bytes through the local machine:
   - **DB** (both stacks) — source `wp db export -` (clean stream — never let plugin
     stdout noise corrupt it; same gotcha as `dbBackup.ts`) piped over SSH into `wp db
     import -` on the dest. Or stage-gzip on source `$HOME` then pull.
   - **files**:
     - **Standard WP** → `rsync -a` the whole source webroot → dest, excluding caches.
       **`uploads/` is synced by default**, with a per-site **option to exclude it**
       and lean on the media-fallback mu-plugin (item 12) for huge libraries.
     - **Bedrock / git** → the *code* already arrived via the deploy, so we pull the
       **gitignored support files the repo doesn't carry**: `web/app/uploads/` (same
       sync-by-default / opt-out), **`auth.json`** (Composer auth for private repos —
       ACF Pro, private Packagist, …; it lives at the project root, so an
       *uploads-only* rsync would miss it — pull it explicitly), and `.env` (step 3),
       plus the DB above. We do **not** rsync the whole tree over a fresh deploy.
   - Run as root on dest, then `chown` to the dest site user.
3. **config — rsync the config, then re-stamp creds on the dest** (decided
   2026-06-26, matching your instinct). The config comes across, and on the dest we
   **adapt its DB credentials + salts** to the dest site's own provisioned values,
   preserving any *other* app config. Per stack via `findProjectRoot`:
   - **Standard WP** → `wp-config.php` rides along in the rsync'd webroot; rewrite its
     `DB_NAME`/`DB_USER`/`DB_PASSWORD` (and salts) to the dest's values (which we set
     in step 1's `database[]`, so it's a deterministic rewrite). Domain unchanged → no
     `search-replace`.
   - **Bedrock** → `.env` is gitignored and **never touched by a deploy**, so we own
     it outright: pull the source `.env`, re-stamp `DB_*` (+ salts) to the dest values,
     keep custom app vars (S3, Sentry, etc.), and write it to the dest. It survives
     every subsequent deploy.
4. **deploy** (**Bedrock only**) — with `auth.json` + `.env` now seeded, re-trigger
   the build via `POST /sites/{id}/git/deploy` → poll the `event_id`. `composer
   install` now authenticates and the app builds. (Standard WP skips this step.)
5. **verify** — see the Verify step below; the site isn't `done` until green.

**Bedrock deploy ordering (the normal rhythm).** When SpinupWP creates the `git`
site it runs the deploy (`composer install`) — and that **first deploy is expected to
fail**, because `composer install` needs the gitignored `auth.json` to reach private
Composer repos and it isn't there yet. This is exactly the manual flow today (create
→ first deploy fails → SSH in, add `auth.json`, set up `.env` → re-deploy), automated:
the chain seeds `auth.json` + `.env` in the pull/config sub-steps, then **re-triggers
the deploy via `POST /sites/{id}/git/deploy`** (async → `event_id`, polled like other
writes). The failed first deploy is normal and is **not** surfaced as a site error;
only the post-seed deploy must go green.

All SSH via the shared `SSH_OPTS`/`runProcess`/`meaningfulError` helpers; per-site
errors are stage-prefixed; `failedStep` marks the broken sub-step on that site's row.

**Throttle.** The cap of **3** is bounded by the **source**, not the dest or your
laptop: N parallel `rsync` + `wp db export` would hammer the live source's disk I/O
while it's still serving real traffic — and the whole safety story is *the source
keeps serving untouched until cutover*. Surfaced as "running N at once" in the roster
header; tunable in Plan.

### 5. Verify (the per-site `verify` column + drill-down)

Each site is HTTP-tested on the new box **without touching DNS** — we know the new
IP:

```
curl --resolve <domain>:443:<NEW_IP> -sS -o /dev/null -w '%{http_code}' https://<domain>
```

That hits the real new server (TLS + vhost) while DNS still points at the old one.
Combined with WP-CLI reads over SSH for a **source-vs-clone diff**, shown as the
focused-row drill-down (`⏎` on a roster row):

| check                      | source | clone |
|----------------------------|--------|-------|
| `wp core version`          | 6.x    | 6.x   |
| `wp db check`              | ok     | ok    |
| active plugins (count)     | n      | n     |
| active theme               | …      | …     |
| `home` / `siteurl`         | …      | …     |
| live HTTP (`--resolve`)    |  —     | 200   |

Green → that site's row turns `✓ done`. A mismatch blocks **that site** (not the
fleet) and explains. Clone sites is complete when every selected site is `done`
(or explicitly skipped after a failure you choose not to retry).

### 6. DNS cutover — batched, partial-aware

The scary one — confirm-before-prod-writes at its hardest, now ×N across
**heterogeneous zones**. Clone-all-first, then one deliberate flip. Per site we
resolve its zone/provider/account and detect editability (reuse the Phase-3 NS-match
pre-flight — re-dig fresh authoritative NS, one `GetHostedZone` per account,
hard-stop if a zone isn't actually live). The roster:

```
│ ⠹ DNS cutover  5/8   │  SITE              ZONE · PROVIDER        cutover │
│                      │  example.com       Route 53 ✓            ✓ 5.161 │
│                      │  shop.example.com  Cloudflare ✓          ⠹       │
│                      │  legacy.org        Route 53 (other a/c)  ⚠ manual│
│                      │  intranet.local    no public DNS          — skip │
│                      │  …                                               │
│                      │  6 editable · 1 manual · 1 skip                  │
│                      │  ❯ Enter flips the 6 editable records together   │
```

This is explicitly a **partial cutover**: a single hard confirm flips every
**editable** record (apex A + `www` + additional-domain A records) from the old IP
to `destServerIp` via `setRecordValue` (Route 53 `UPSERT`; Cloudflare `PATCH
content`). Non-editable sites get a **manual list** with the exact records to change.
Final propagation check via authoritative reads; on success, **revoke the granted
pull key from the source sites** (if that path was used — no-op for agent forwarding)
and **restore any lowered TTLs**.

This requires **DNS record-value editing**, which doesn't exist yet — the module
only edits TTL today. We add `setRecordValue` (the editor was already built to hold
both TTL and target as two fields of one record edit, per the Phase-3 spec — this is
the planned extension).

### Terminal state — a summary, not a binary

With many sites, "done" is a **summary**: `7 cloned · 6 cut over · 1 manual`. A site
that failed and wasn't retried is reported, not swept under "error." The job stays
recoverable from the header badge / its server until dismissed.

## Files

**New**
- `src/ui/views/CloneWizard.tsx` — the two-pane overlay (journey rail + per-step
  right pane; the two roster macro-steps + per-site drill-down).
- `src/lib/serverClone.ts` — the orchestrator: the per-site concurrent (cap 3) pull
  chain + verify, built on the `ssh.ts` sudo transport + `dbBackup.ts` helpers; the
  pull-auth path per the Connect-dest decision (per source site: probe forwarding →
  else generate-on-dest + one-pass grant, revoked at job end).

**Extend**
- `src/lib/serverCreate.ts` — `providerMetadata()` + the create payload (already
  present). No foothold injection — sudo is user-provisioned (Connect dest).
- `src/api/types.ts` — extend `CreateSitePayload` with a `git` block
  (`repo`/`branch`/`deploy_script`/`push_enabled`) for cloning Bedrock sites.
- `src/api/client.ts` — `createServer()`, `createSite()` (+ the `git` block),
  `runGitDeployment(siteId)` (`POST /sites/{id}/git/deploy`),
  `providerMetadata()` (present); confirm `database[...]` + git-on-create shape.
- `src/lib/dnsRecords.ts` — `setRecordValue()` (IP repoint) for Route 53 +
  Cloudflare.
- `src/ui/store.tsx` — the `cloneJob` slice (`startClone`, `advanceClone` reducing
  over `sites[]`, per-site polling + pull progress, concurrency gating, cutover).
- `src/ui/App.tsx` — overlay registration + keyboard early-return.
- `src/ui/views/Browser.tsx` — **`C`** launch key on a **Servers** row (clone this
  server); `src/ui/Help.tsx` lines. Verify `C` is free in the Servers context.

## Build sequence (each independently shippable / testable)

1. **New-server screen as the standalone action.** First real `POST /servers`;
   validates pricing + the provisioning poll. (The foothold is the separate
   Connect-dest step — sudo is user-provisioned, not baked into create.)
2. The **wizard shell** (two-pane, `CloneJob` + `sites[]` state, journey rail, Plan
   with site-select + sizing, the New-server + Trust-source steps).
3. **Connect dest** — the sudo handoff (SpinupWP deep-link → `SudoConnect`) + the
   pull-auth path: per source site, probe forwarding → else generate-on-dest +
   one-pass grant (+ end-of-job revoke), reusing GrantKey machinery.
4. **Clone sites** — the concurrent (cap 3) per-site pull chain (`serverClone.ts`),
   roster + per-site retry, resumable/idempotent runners. Ship the **Standard WP**
   path (`blank` + full rsync + re-stamp `wp-config.php`) first, then the **Bedrock /
   git** branch (`git` create + carry `git[...]`/`deploy_script`, pull DB + the
   gitignored support set `uploads/` + `auth.json` + `.env`, then deploy).
5. **Verify** — WP-CLI diff + `--resolve` HTTP, per-site column + drill-down.
6. **DNS cutover** — `setRecordValue` + the migration pre-flight, batched +
   partial-aware. Last and riskiest.

## Safety

- Two hard confirms gate the only irreversible/charged actions: **server creation**
  (costs money) and **DNS cutover** (moves live traffic). Everything between is
  additive (a new server + new sites nobody points at yet) and safe to abandon.
- The clone **never mutates the source** — it only reads (DB export, file rsync-read,
  WP-CLI reads). If the pull uses a granted key it adds **one** short-lived key to the
  source sites and revokes it at the end; agent forwarding adds nothing. The source
  keeps serving until the user pulls the DNS trigger.
- The throttle (3 concurrent) protects the live source's I/O during the copy.
- Token-scope: a 403 on any write surfaces the existing read-only message; the read
  path is never broken.
- Sudo passwords live in memory only (never disk), per `SudoConnect`; generated creds
  (dest DB root / site DB creds / any pull key) are never printed.

## Decisions (2026-06-26)

1. **Config** — **rsync the config across, then re-stamp creds on the dest** (not
   skip-overwrite). Per stack via `findProjectRoot`: rewrite `wp-config.php` `DB_*` +
   salts (Standard WP), or pull + re-stamp `.env` keeping custom vars (Bedrock).
2. **Large uploads** — **sync `uploads/` by default**, with a per-site option to
   exclude it (lean on the media-fallback mu-plugin, item 12, for huge libraries).
3. **`site_user` collisions** — **non-issue**; reuse the source `site_user` verbatim
   (unique per source server already). Only derive a unique name if SpinupWP rejects a
   duplicate.
4. **Launch key** — **`C`** on a Servers row (verify it's free in that context).
5. **`installation_method`** — `blank` + `database[...]` for **Standard WP**;
   `git` + `git[...]` + `deploy_script` + `database[...]` for **Bedrock/git** sites
   (extend `CreateSitePayload`). The `wp*` methods install a fresh WP and are unused.
6. **Pull auth** — granted key as the mechanism, agent forwarding as a per-site
   skip-the-grant fast-path. Both converge on logging into the source *as the site
   user* (see Connect dest).
7. **Bedrock support set + deploy** — pull the gitignored files the repo omits
   (`web/app/uploads/` + `auth.json` + `.env`); the create-time first deploy is
   **expected to fail** (no `auth.json` yet), so after seeding we re-deploy via
   `POST /sites/{id}/git/deploy` and that's the build that must go green.

## Open questions — ANSWERED 2026-06-27 (see `docs/2026-06-27_site-creation-api-findings.md`)

Resolved by building the real test source (`wp.spinuptui.com` + `bedrock.spinuptui.com`
on web1). **Several assumptions here were wrong — corrections, in order of impact:**

1. **`deploy_script` is TOP-LEVEL on `POST /sites`, NOT inside `git`.** The git block
   uses `push_to_deploy` (not `push_enabled`) + `always_run_deploy_script` +
   `deploy_key_enabled`/`deploy_key{}`. Response normalizes to
   `git.{deploy_script,push_enabled,deployment_url}`. So `CreateSitePayload` needs a
   top-level `deploy_script` + a `git` block with `push_to_deploy`/`always_run_deploy_script`
   — NOT the `git[deploy_script|push_enabled]` shape assumed above.
2. **`POST /sites/{id}/git/deploy` does NOT run the deploy script** — only `git pull` +
   checkout (verified even with `vendor/` deleted and `always_run_deploy_script:true`).
   So **a fresh Bedrock dest is never built by the API deploy** → the wizard must run
   **`composer install -o --no-dev` over its sudo SSH connection** (NOT rely on the
   `git/deploy` re-trigger described in "Bedrock deploy ordering" above). The create
   step also only *clones* — it does not install WP or run the script.
3. **`git` create accepts `database{}`** — yes; it provisions a DB. `table_prefix`
   echoes `null` but applies; the DB password is never returned, so always *send* it.
   (`blank`/Standard-WP `database{}` likewise accepted.)
4. **No site/git update endpoint** (only `PUT /sites/{id}/php`) → get the create payload
   right or delete + recreate. **Deleting a site leaves its DB orphaned** → a retried
   dest create can collide on `database.name`; clean or uniquify.
5. **`site_user` must be ≥3 chars** (affects "reuse source site_user verbatim").
6. **A git/Bedrock site is `is_wordpress:false`** even once WP is installed → branch on
   `git.repo`, not `is_wordpress` (as already planned). The deploy key to add to the repo
   is the **server's `git_publickey`** (`GET /servers/{id}`).
7. Deploy-script flag: the canonical `--optimize-autoload` is invalid for `composer
   install` (use `-o` / `--optimize-autoloader`).

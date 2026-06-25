# Vanity Site — connect a freshly-created server — spec

Backlog item 5 companion (raised 2026-06-25). The step *after* server creation
(`docs/2026-06-24_clone-to-server-spec.md`): turn a bare, unreachable server into
one Spinup can actually work with, by creating a small placeholder ("vanity") site
at the server's own hostname.

Builds on: the write scaffolding from PHP upgrade (item 8, `mutate()`/`getEvent` +
the confirm overlay), the server-create flow (`NewServer.tsx`, this session), the
SSH/WP-CLI helpers in `src/lib/dbBackup.ts`, the DNS module
(`docs/2026-06-22_dns-phase3-migration-spec.md`, `src/lib/dnsRecords.ts`), and the
`#`-anchor deep-link handoff pattern.

## The product

> "I just made a server. It has no site, so I can't attach an SSH key or reach it —
> Spinup can't do anything with it. Give me a one-action way to make it real."

A brand-new SpinupWP server is a dead end in Spinup: with **zero sites** there's no
site system user to hang an SSH key on, nothing to probe, no foothold. The vanity
site solves exactly that — a tiny placeholder served at the server's hostname
(e.g. `spinup-test.wenmarkdigital.com`) that:

1. forces SpinupWP to provision a **site system user** (the thing you add an SSH key
   to → Spinup can finally SSH in),
2. gives a **real URL** that returns 200 (server-is-up page, WHMCS-uptime-readable),
3. exercises — for the first time — a **brand-new DNS record write** (the A record).

The amber `0` on a server row (added this session) is the breadcrumb that leads
here.

### Discovery signal: "connected but empty"

The SpinupWP API's `server.connection_status` is a **control-plane** fact — can
SpinupWP manage the box — and is independent of sites, so a bare server reads
`connected` with 0 sites. That's truthful but not the question the user has ("can
*I* use it yet?"). Spinup layers a **derived readiness** signal *on top of* (never
overwriting) the API status:

- `disconnected` / `connecting` → provisioning or unreachable — wait.
- **`connected` + 0 sites → "connected but empty"** — manageable but unusable (no
  site to attach an SSH key to / deploy). **This is the vanity-site entry point.**
- `connected` + ≥1 site → usable.

Surface the middle state explicitly (e.g. Details pane: *"Connected · no sites yet
— create a vanity site to use it"*) rather than making the user infer it from the
green dot + amber `0`. Keep `connection_status` as-is alongside it — the
disconnected-vs-connected-but-empty distinction is worth preserving.

## Placement (decided 2026-06-25)

**Not** in the server-create flow — a CTA in the **Sites-panel empty state**
("No sites on this server"). Rationale: server provisioning is ~10 min and async;
a site can't be created until the server is provisioned AND connected, so coupling
them would defeat fire-and-walk-away. The empty state is also where the dead end is
*felt*, it serves any 0-site server (not just freshly-created ones), and it
composes cleanly (server-create stays a standalone, reusable action). The
New Server success screen now hands off here in words.

## The flow (gated, resumable like other writes)

1. **Offer** — in `Browser.tsx` the Sites empty state, when the focused server has
   0 sites, shows a CTA (proposed key: `n` "new vanity site" — verify no collision
   with the Sites pane's existing keys).
2. **Confirm** — overlay (modeled on `PhpUpgrade.tsx`) showing the domain
   (= server hostname), the target server IP, and the DNS record that will be
   written. Hard confirm — this is a real production DNS write.
3. **DNS A record** — create `A <hostname> → <server.ip>` via the connected zone's
   provider, then poll to propagation (Route 53 async pollId; Cloudflare immediate).
4. **Create site** — `POST /sites` (new client method, see gaps) → `getEvent` poll
   to provisioned, mirroring `startNewServer`.
5. **SSH key / sudo user** — deep-link handoff to SpinupWP for the parts the API
   doesn't cover (see gaps): e.g.
   `…/servers/{id}#sudo-users` to add a sudo user / SSH key.
6. **Seed `index.php`** — once SSH reaches the site user, push
   `docs/vanity-site/index.php` into the site webroot via the existing SSH/SCP
   helpers (`dbBackup.ts` exports `SSH_OPTS`/`scpPort`/`runProcess`).
7. **Done** — server now shows 1 site (amber clears); it's connectable.

Each step lives in a store-resident job so closing the overlay doesn't abandon it,
and it adopts the **shared resumable-job mechanism** (config-persisted, resumes on
restart) defined in `docs/2026-06-24_clone-to-server-spec.md` "Resumable jobs"
rather than inventing its own; a global header badge surfaces it like the provision
badge.

## Known gaps to build (verify against the SpinupWP API before coding)

- **`client.createSite(payload)` does not exist.** Add it + a `CreateSitePayload`
  type. The clone spec already verified the API (`POST /sites`, async → `{event_id}`):
  required `server_id`, `domain`, `site_user`, `installation_method`; use
  **`installation_method: "blank"`** for exactly the no-WP docroot we want to drop
  `index.php` into. See `docs/2026-06-24_clone-to-server-spec.md` "Create site". The
  client method is shared with the clone wizard — build it once.
- **DNS record CREATE vs EDIT.** `dnsRecords.ts` today reads-then-upserts an
  *existing* record (TTL editing). Route 53 `UPSERT` can create a new record set as
  is; **Cloudflare** edits via PATCH to a known `recordId`, so creating a new A
  record needs a `POST` path. Add a `createRecord` capability to the record-provider
  descriptors (both providers).
- **SSL/Let's Encrypt ordering.** LE issuance needs the hostname to resolve, so the
  A record must propagate *before* (or SSL is added after) site creation. Decide:
  create site without SSL first, or wait out propagation. SpinupWP may handle LE on
  its own timeline — confirm.
- **SSH key application.** SpinupWP SSH access is via the site/sudo system user; our
  client has no SSH-key endpoint. Likely a **deep-link handoff** (consistent with
  existing patterns) rather than an API write. Confirm whether the API exposes it.

## Hard rules

- The DNS A-record write and the site creation are **production writes** → explicit
  confirm before firing, exact values shown ([[feedback-confirm-before-prod-writes]]).
- Reads/inventory must keep working on a read-only token; the vanity action greys
  out without write scope.
- `index.php` is brand-neutral by design (reads `$_SERVER['HTTP_HOST']`, no logo);
  never bake a client's branding into it.

## Open questions

- CTA key in the Sites empty state (avoid collisions with site-pane keys).
- Whether to also offer "seed `index.php`" as a standalone re-runnable action.
- Whether the vanity domain should ever be an apex (server hostnames are subdomains
  in practice, so A-record-on-subdomain is the assumed case).

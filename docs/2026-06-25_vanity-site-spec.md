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

## Decisions (user, 2026-06-25)

- **SSH key: manual via deep-link.** No default-key auto-apply on this account, and
  the API has no SSH-key endpoint, so the flow deep-links the user into SpinupWP to
  add their key, then resumes to seed `index.php` once SSH reaches the site.
- **SSL: yes (Let's Encrypt).** Enabled via the separate `POST /sites/{id}/https`
  call *after* the A record propagates (LE needs the host to resolve).
- **DNS provider: AWS Route 53** for `wenmarkdigital.com`. Route 53 `UPSERT`
  creates-or-replaces, so a new A record needs only a thin extension of the existing
  record-write path (no new POST shape, unlike Cloudflare).

## Verified API contract (SpinupWP REST API, 2026-06-25)

- `POST /sites` — required `server_id`, `domain`, `site_user`, `installation_method`
  (`wp | wp_subdirectory | wp_subdomain | git | blank`); optional `php_version`
  (def 8.3), `public_folder` (def "/"), `database[name|username|password|table_prefix]`,
  `page_cache[enabled]`. **No HTTPS field at creation.** Async → `{ event_id }`.
- **HTTPS is a separate, post-creation call:** `POST /sites/{id}/https` → `{ event_id }`.
- Built this session: `CreateSitePayload`, `client.createSite()`, `client.enableHttps()`.

## The flow (gated, resumable like other writes)

1. **Offer** — in `Browser.tsx` the Sites empty state, when the focused server has
   0 sites, shows a CTA (proposed key: `n` "new vanity site" — verify no collision
   with the Sites pane's existing keys).
2. **Confirm** — overlay (modeled on `PhpUpgrade.tsx`) showing the domain
   (= server hostname), the target server IP, the A record to be written, the
   `site_user`, and that SSL + an SSH-key handoff follow. Hard confirm — real
   production DNS + site writes.
3. **DNS A record** — `A <hostname> → <server.ip>` via Route 53 `UPSERT` (new
   `createRecord` path in `dnsRecords.ts`), then poll DNS until it resolves to the
   server IP (reuse `dnsQuery.ts`) — LE needs this before step 5.
4. **Create site** — `client.createSite({ installation_method: "blank", site_user,
   … })` → `getEvent` poll, mirroring `startNewServer`.
5. **Enable HTTPS** — `client.enableHttps(siteId)` → `getEvent` poll. Gated on the
   A record having resolved (step 3).
6. **SSH key** — deep-link handoff to the SITE's SFTP & SSH → Site User
   (`/sites/{siteId}#sftp`), where the key is added to the per-site user (NOT a
   server sudo user). No API for this; the job parks here until the user confirms.
7. **Seed `index.php`** — once SSH reaches the site user, push
   `docs/vanity-site/index.php` into the site webroot via the existing SSH/SCP
   helpers (`dbBackup.ts` exports `SSH_OPTS`/`scpPort`/`runProcess`).
8. **Done** — server now shows 1 site (amber clears); it's connectable.

Each step lives in a store-resident job so closing the overlay doesn't abandon it,
and it adopts the **shared resumable-job mechanism** (config-persisted, resumes on
restart) defined in `docs/2026-06-24_clone-to-server-spec.md` "Resumable jobs".
Steps 3–5 are event/poll-backed (true resume); step 6 is a manual park (resume =
re-show the handoff); step 7 is an idempotent SSH push (resume = re-check then
re-run) — the same mixed-resume shape the clone wizard needs. A global header badge
surfaces the job like the provision badge.

## Remaining gaps to build

- **DNS record CREATE.** `dnsRecords.ts` today reads-then-upserts an *existing*
  record (TTL editing). Add a `createRecord` path; for Route 53 it's the same
  `UPSERT` action with a fresh record set, so it's a thin extension. (Cloudflare's
  POST path deferred until a non-Route-53 zone needs it.)
- **DNS propagation poll** before enabling HTTPS — resolve the new A record via
  `dnsQuery.ts` until it returns the server IP (with a sane timeout/skip).
- **The VanityJob model + overlay + Sites-empty-state CTA** — the orchestration.

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

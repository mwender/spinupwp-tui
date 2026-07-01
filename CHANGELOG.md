# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is in `0.x`, the public surface (CLI subcommands/flags, config
file location and format, and token-resolution behavior) may change between minor
versions; such changes are called out here.

## [Unreleased]

## [0.10.0] - 2026-07-01

### Added
- **Servers running an end-of-life Ubuntu release are flagged.** SpinupWP's own
  web app warns when a site's Ubuntu version can no longer get new PHP installs —
  Spinup now surfaces the same signal proactively, fleet-wide. A server whose
  Ubuntu LTS release is past Canonical's published EOL date shows ` ⚠ os` in the
  Servers list, a red-flagged "Ubuntu … EOL, clone to newer (C)" line in its detail
  panel, and a "Needs attention" entry on the Dashboard pointing at the clone
  wizard (`C`). EOL dates come from the same embedded-table-plus-endoflife.date-
  refresh approach already used for PHP EOL, so it stays current without a
  Spinup release (`src/lib/ubuntuEol.ts`).
- **Access notes for zones you can't reach via API — any `↗ web`-only host, not
  just GoDaddy.** DNS providers with no API (GoDaddy's is gated to large/reseller
  accounts; Namecheap, Network Solutions, and others never had one) used to show
  as an undifferentiated `↗ web` in the DNS inventory, with no way to tell "I have
  delegate access to this myself" from "a third party manages this domain." The
  inventory's NOTE column now shows a global assumed default ("Delegate Access" —
  most registrars are managed the same way) or, when set, a per-zone override in
  amber — e.g. a note pointing at the third-party IT vendor for the one client
  domain you don't manage directly. Set/clear the override from `c` "Manage
  Access" on any inventory row (widened from GoDaddy-only to any host with a web
  handoff): the previously-empty Zones pane lists every zone already known
  fleet-wide for that host (from prior DNS lookups), landing the cursor on the
  zone you opened it from; press `n` to edit its note, or `r` to resolve every
  fleet domain and fill in any gaps. Only exceptions are ever stored — the common
  case costs zero config.

## [0.9.1] - 2026-06-30

### Changed
- **The "update available" hint is easier to spot.** The `✦ vX.Y.Z` nudge in the
  header (and the `?` About panel) is now **bright gold** and bold, instead of the
  same green as the wordmark — so a newer release stands out at a glance.

## [0.9.0] - 2026-06-30

### Added
- **Completion toasts for background writes.** When a **PHP upgrade** or a **server
  reboot / service restart** finishes, a non-focus-stealing toast slides in at the
  top-right — `web3.example.com upgraded to PHP 8.3`, `web1.example.com rebooted`,
  `Nginx restarted on web1.example.com`. These operations keep tracking in the
  background after you close their overlay, so the toast is the "it's done" signal you
  would otherwise have to go looking for; it auto-dismisses (~4s) and never takes
  keyboard focus. Built on `@opentui-ui/toast`.
- **Privileged writes over SSH: connect sudo (`S`) + grant Spinup's SSH key (`K`).**
  The first things Spinup writes that the SpinupWP API simply can't do (it has no
  SSH-key or sudo-user surface). Press **`S`** on a server to **connect sudo** for the
  session: enter the SpinupWP sudo user + its sudo password once, Spinup validates
  them against the live server, and then holds them **in memory for the session
  only** (the username persists to config; the **password is never written to
  disk**). A connected server shows a green **● sudo** on its row; press `S` again to
  disconnect. With sudo connected, press **`K`** on a site to drop Spinup's
  **dedicated machine key**
  into that site user's `authorized_keys` over sudo — an ed25519 identity generated
  once into the config dir (`keys/spinup-tui`), commented `spinup-tui@<your-host>`,
  and deliberately **never added to your SpinupWP account** so SpinupWP's
  `authorized_keys` reconciliation leaves it untouched. The remote script is
  **idempotent** (`grep -qxF` — re-running never duplicates the line), and a confirm
  overlay shows the exact remote command before anything fires. **`K` shows a key
  picker:** choose any of **your personal keys** (discovered from `~/.ssh/*.pub` and
  the ssh-agent — so you can SSH/SFTP as yourself) and/or the **machine key**, deploy
  several at once, and your selection is remembered for next time. **Choose the scope**
  too: just this site, or **every site on the server** in one pass (the same idempotent
  append runs on each, with a per-site progress readout and a retry for any that fail).
  And when you **connect a new server (vanity flow)**, you can connect sudo right from
  the flow (`S`, same as on a server); with sudo connected, the SSH-key step grants your
  saved keys there (`g`) and publishes — no more manual "add your key in SpinupWP"
  round-trip. The site list shows which keys are on a site at a glance — **👤 your key**
  and/or **🔑 the spinup-tui machine key** — and the Details panel spells it out
  (`Granted   your key + spinup-tui`). The same `K` overlay can **remove** keys too
  (`a`/`r` to toggle grant/remove) — the reverse of grant, leaving every other key (incl.
  SpinupWP-managed ones) untouched. See `docs/2026-06-26_sudo-ssh-key-provisioning-spec.md`.
- **Save your sudo password to the macOS Keychain (opt-in).** Connecting sudo (`S`)
  now offers a **"Remember in macOS Keychain"** toggle. Tick it and the next time you
  open `S` on that server, sudo **auto-unlocks** — no re-typing the password. The
  password lives **only** in your login Keychain (service `spinup-sudo`, one item per
  server) and the in-memory session; **`config.json` never holds it** — only the
  username and a `keychain: true` marker. Manage it from the connected panel: **`f`**
  forgets the saved password (the live session stays connected), and disconnecting
  (**`x`**) a saved server shows a **no-password reconnect** panel (`⏎` to reconnect,
  `f` to forget) instead of the credential form — you never re-enter a password
  Spinup already holds. The first auto-unlock may surface macOS's own "allow access"
  prompt; choose **Always Allow** and it stays silent after. Off macOS this is absent
  and sudo stays in-memory per session, exactly as before. Uses the built-in
  `security` CLI — no new dependencies.
- **Create a new server (`c`).** Press `c` on a server in the Servers tab to
  provision a new one, pre-filled to **match** the selected server's provider,
  region, and size. The form prices the build from the provider's catalog
  (DigitalOcean / Vultr / Linode / Hetzner) so you see a monthly cost before
  confirming, suggests a hostname from your fleet's naming convention (e.g. the
  next `webN.example.com`), and lets you switch provider (`p`), region (`g`), or
  size (`e`) and toggle backups. The
  build fires `POST /servers` and tracks the ~10-minute provisioning in the
  background, so closing the overlay doesn't abandon it. Because the SpinupWP API
  can't list your configured server providers, the first time you create on a
  provider the overlay asks for its SpinupWP provider id (from Account Settings →
  Server Providers) and saves it for you — once per provider, no hand-editing
  config. First step of the clone-to-new-server workflow (see
  `docs/2026-06-24_clone-to-server-spec.md`).
- **Clone a whole server to a new one (`C`).** Press `C` on a server to open the
  clone wizard — a guided, two-pane journey that lifts one or more of a server's
  sites onto a fresh (or existing) destination, **without touching DNS until you
  say so**, so you can stage and verify a migration before cutting over. The steps:
  **Plan** — pick which of the source's sites to clone (all selected by default;
  `space` toggles), and Spinup sizes each one live (`du` + `wp db size`) into a
  payload total so you know what you're moving; a concurrency throttle protects the
  source. **Destination** — provision a new server pre-matched to the source, or
  `d` to pick an existing server as the target. **Connect** — connect sudo on
  **both** ends (the clone is a server-to-server **pull**: the destination pulls
  from the source over SSH using a granted key + agent forwarding, and the source
  key is revoked when it's done). **Clone sites** — a live roster runs the sites
  concurrently, each advancing `create → pull → config → verify → done`. Both
  stacks are handled: **Standard WP** (files via tar-over-ssh, DB via cat-over-ssh,
  wp-config re-stamped for the dest) and **Bedrock** (git-native — create from the
  repo, `composer install` over SSH, pull `uploads` + `auth.json`, re-stamp `.env`
  keeping custom vars). **Verify** — a source-vs-clone drill-down (wp-cli value
  diff + a `--resolve` HTTP check that hits the new server while DNS still points at
  the old one). **DNS cutover** — when you're satisfied, repoint **every** A record
  across each site's domains (apex + additional) to the new server in one batched,
  partial-aware pass; www-style CNAMEs that follow the apex are skipped, not
  clobbered. The clone runs in the **background** — `esc` doesn't abandon it; a
  header badge (`⠹ Cloning <server> — press C`) surfaces the in-flight job and `C`
  on the source reopens the live roster. See
  `docs/2026-06-24_clone-to-server-spec.md`.
- **Connect a new server with a vanity site (`V`).** A freshly-created server has
  no site, so there's nothing to attach an SSH key to and no way for Spinup to
  reach it. Press `V` on a server with no sites to build a small placeholder site
  at the server's own hostname: Spinup writes the DNS A record (Route 53), waits
  for it to resolve, creates the site, enables HTTPS (a free Let's Encrypt
  certificate), hands you off to add your SSH key (the site's **SFTP & SSH → Site
  User**), then publishes a minimal, brand-neutral status page. Press `o` on the
  success screen to open the live site. The whole build runs in the background and
  survives closing the overlay — reopen it with `V`, and a header badge tracks it.
- **Background jobs survive a restart.** Long-running work — a server provision, a
  PHP upgrade, a vanity-site build — is now persisted, so quitting and relaunching
  Spinup reconnects to it instead of forgetting it. SSH-based jobs that can't be
  reconnected (a production DB backup/sync) are clearly flagged as **interrupted**
  on restart rather than silently lost.

### Changed
- **New-server progress shows a live elapsed timer**, and a header badge surfaces
  an in-flight provision (or vanity-site build) from any tab.
- **Servers with no sites are flagged in amber** in the Servers list — an empty
  server is a dead end until it has a site (press `V` to create one).
- **The vanity build's "Wait for DNS to propagate" step now shows a timer.** A
  live count-down (`m:ss left`) ticks through the ~2-minute window; if it lapses you
  can **keep waiting** (`w`) and the timer flips to a count-up (`m:ss elapsed`) from
  that same point so you can see exactly how long it's been — without being prompted
  again. From there, **`c` continues now** (create the site and move on) or **`s`
  skips SSL** (publish over HTTP and add the certificate later).
- **DNS connection resolution re-checks itself instead of trusting a stale cache.**
  Writing the vanity A record (and, later, the clone DNS cutover) used a cached list
  of which zones each connected account serves; a zone you registered *today* wasn't
  in it, so the build failed with a misleading "no editable DNS connection serves
  this zone." Now, when no account matches but one *is* connected for that provider,
  Spinup re-verifies that provider's accounts and retries before giving up — so a
  freshly-registered zone just works, no manual refresh. The cache also expires
  entries after 24h so they refresh on their own. The error messages now distinguish
  "no account connected" from "connected but it doesn't serve this zone."

## [0.8.0] - 2026-06-23

### Added
- **Production media fallback (`m`).** After a `p` DB pull, your local site shows
  broken images because the media library isn't synced. Press `m` on a linked
  WordPress site to drop a small, self-contained mu-plugin that serves any
  **missing-locally** upload straight from production — so images resolve without
  copying a single file. It runs in WordPress (pure PHP), so it works the same on
  any local stack (Valet / Herd / LocalWP / DDEV / MAMP) with no web-server config.
  It decides "missing" from the real document root and redirects to the **same
  path** on production, so it covers page-builder URLs (Elementor inline CSS &
  gallery data), **legacy `/wp-content/uploads` paths** left from a Bedrock
  conversion, and CDN/S3 redirects (production's own routing resolves them).
  Local-only and read-only on production; self-disables on the production domain
  so it's inert if ever deployed. The plugin's presence is its on/off state (no
  config); `m` toggles it and the overlay offers an in-place update when a newer
  version ships. (See "Production media fallback" in the README.)
- **App version, About, and update check.** The header now shows the running
  version next to the wordmark (`◆ Spinup vX.Y.Z`). The `?` help overlay is
  redesigned into a responsive multi-column layout with an **About** column
  (version, how to update, repo). On launch the app checks the latest GitHub
  release (cached on disk for 6h — no background polling) and, when a newer
  release exists, shows a `✦ vX.Y.Z` hint in the header and the About panel.

### Changed
- **The app is now called "Spinup".** Renamed the app's own branding — the
  header wordmark, the help/About panel, and the CLI banner — to **Spinup**, since
  it's a control center for your *SpinupWP account*. References to the SpinupWP
  *service* (the web app via `w`, the API, deep links) are unchanged.

## [0.7.1] - 2026-06-23

### Added
- **Scaffold a post-import hook from the sync screen.** When you press `p` on a
  linked site that has no `bin/sync.d/post-import.sh`, the confirm screen now
  explains what the hook is (it runs after the import + URL rewrite) and offers
  `s` to write an **inert** sample for you — a documented `post-import.sh` with
  the `WEB_DIR` / `SYNC_REMOTE_HOST` / `SYNC_LOCAL_HOST` env contract and common
  examples (Elementor URL swaps, plugin toggles), all commented out so nothing
  runs until you uncomment it. It never overwrites an existing hook.

### Changed
- **Backup (`d`) and sync (`p`) now show progress as a building checklist.** Each
  step (back up local, export, download, import, rewrite URLs, run hook) is listed
  in one bordered panel and gets a `✓` as it finishes, the running step spins, and
  the final result (saved paths, size) appears below the completed stack — so the
  whole operation, including the "done" summary, reads in a single frame. A
  failure marks the exact step that broke with `✕` and shows the error inline.

## [0.7.0] - 2026-06-22

### Added
- **Edit DNS record TTLs — the first DNS write.** From the DNS view, press `⏎` on a
  site's hosting record to open a focused editor and change its TTL (a preset or a
  custom value). This is the prep step for a low-risk server migration: lower the TTL
  before you cut over, then restore it after. Writes go to **AWS Route 53** or
  **Cloudflare** through your connected account, behind a confirm step. An edit-time
  safety check re-reads the live nameservers and **blocks the write** if the account's
  zone isn't the one actually serving the domain — so you can't edit a stale or
  duplicate copy. Route 53 changes are followed to completion; the record shows an
  "updating" status that keeps ticking even if you leave the view.
- **Open the DNS view scoped to one site.** Press `n` on a site (Servers or Search)
  to open the inventory for just that site's domains and records — the view you want
  when migrating a single site. Press `a` inside to expand to the whole server.
- **Download a production database backup.** On a linked WordPress site, press
  `d` in Search to export the production database with `wp-cli` (into a stage file
  *outside* the public webroot), gzip it, download it into the linked copy's
  `sql/` folder, and remove the remote copy. **Read-only on production** and needs
  no local WP-CLI — the export runs on the server. The remote document root and
  SSH target are derived from the API; SSH/scp run non-interactively. A spinner on
  the site's row tracks an in-flight download even after the overlay is closed.
  (See "Database backup & sync" in the README.)
- **Pull production → local DB sync (opt-in).** Press `p` on a linked WordPress
  site to refresh your **local** database from production: it backs up the local
  DB first, exports + downloads production, imports it locally, rewrites
  production URLs → your local URL (`wp search-replace`), and runs an optional
  `bin/sync.d/post-import.sh` hook if the project has one. Works with Standard WP
  and Bedrock, detecting the local WordPress root, local URL (link or `.env`
  `WP_HOME`), and table prefix automatically — no per-site config. **It overwrites
  your local database, so it's off by default**; enable it with `localSync` (a
  `config.json` field, preferred, or the `SPINUPWP_LOCAL_SYNC` env var). Read-only
  on production.
- **Site Control panel.** The Search result's action menu is now grouped
  (Open / Remote / Local / Server) so the growing set of per-site actions stays
  scannable.

### Changed
- **The DNS view is now a migration lens, organized by site.** It shows only the
  records that "count" when you move a site — each **site** on its own line (labeled
  by the site's own domain, even when it's a subdomain), its hosting record's
  type / TTL / value, a `◀ here` flag when the record points at this server, and a
  `+www` tag when `www` simply follows the apex. A site's additional domains nest
  beneath it, so a domain portfolio reads as one site, not many. TTLs are shown in
  **seconds** (e.g. `3600`), and editing happens in place — there's no full-zone
  record list to get lost in.

### Notes
- Only the **TTL** is editable so far (repointing a record's target is a later step).
  Cloudflare **proxied** records are read-only (their TTL is managed by Cloudflare).
  By design the DNS view only ever touches a site's own hosting records — your MX,
  TXT, and other zone records are never shown or modified, so moving a site can't
  take down its email.
- Editing a Cloudflare record needs a token scoped to `Zone.DNS:Edit` (the read-only
  `Zone:Read` token from the host inventory isn't enough).
- The DB backup/sync actions only appear for **WordPress** sites (they use
  `wp-cli`), and only when the site is **linked** to a local copy (the backup's
  destination). The destructive sync additionally requires the `localSync` opt-in.

## [0.6.0] - 2026-06-20

### Added
- **DNS host inventory.** A new read-only DNS module that answers "where is each
  domain's DNS hosted?" — the inventory you'd otherwise build by hand to migrate
  or clone a site. Press `n` on a site to look up its domains' hosts; press `N`
  on a server for a full, zone-keyed inventory of every domain on it. The unit is
  the **zone**: `www` and the apex collapse together, and a separate-TLD redirect
  (e.g. an alternate domain) surfaces as its own zone with its own host, so a full
  portfolio move doesn't miss anything. Hosts are detected from a live nameserver
  lookup (no `dig` dependency) and labeled (Cloudflare, AWS Route 53, GoDaddy,
  …), falling back to the nameserver domain for anything unrecognized. Results
  are cached with a visible age; `r` refreshes.
- **DNS access detection.** Each zone also shows whether you can **edit** it:
  `✓` editable · `↗` web only · `○` needs key · `·` unknown. A zone is `✓` only
  when a connected account of the provider that actually serves it (its live
  nameservers) holds it — so a stale or duplicate zone in another account doesn't
  give a false green. With more than one account connected, an **ACCOUNT** column
  names the owning account.
- **Connect DNS providers.** Press `c` on a zone to manage credentials for its
  provider — **AWS Route 53** (an access key for an IAM user scoped to Route 53
  reads), **Cloudflare** (a `Zone:Read` scoped token), or **GoDaddy** (a
  Production API key). Multiple accounts per provider are supported, with a
  two-pane drill-down into each account's zones. Credentials are verified on the
  spot (only stored if they work) and kept in `config.json` (chmod 600); standard
  environment variables (`CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`, `GODADDY_API_KEY` / `GODADDY_API_SECRET`) are honored too.
- **GoDaddy web fallback.** GoDaddy's API is only available to larger accounts, so
  a GoDaddy zone shows `↗` and `w` (from the inventory or the connect overlay)
  opens your GoDaddy **Clients hub** and copies the domain to your clipboard —
  with an in-context note on the assumed Delegate-Access workflow.
- **Masked secret entry.** Tokens and secret keys are masked as you type, in both
  the DNS provider forms and the first-run **API-token onboarding** screen.

### Notes
- The DNS module is **entirely read-only** — it lists hosts and verifies access;
  it does not change any DNS records (editing is a later phase). Provider
  credentials are optional: without them you still get the full host inventory,
  just without the editable/account columns.

## [0.5.0] - 2026-06-19

### Added
- **Link local working copies.** Press `L` on a site (Servers / Stacks / Search)
  to link it to its local checkout — a path plus the local URL where you serve it.
  The site's details gain a "Local" field, and you can open the copy with `t` (a
  terminal at the path) or `v` (its local URL in your browser).
- **Auto-discover local copies.** Press `S` in the Stacks tab to scan one or more
  folders and match their subdirectories to sites — by git remote, Bedrock
  `WP_HOME`, or folder name — then batch-link the matches. Add scan folders inline
  (comma-separated) the first time.
- **"Needs a local copy" report.** Press `f` in the Stacks tab for the managed
  sites you have no usable local copy for (never linked, or a missing path),
  alphabetical and filterable by stack with `←/→`; `a` trims to the ones needing
  attention (pending updates).
- **Local drift at a glance.** A linked, on-disk site shows `⇡N unpushed` /
  `● uncommitted` in the context strip (read from the local repo; no network).
- **SSH into a site.** Press `s` on a site to open a new terminal already running
  `ssh` into it (`{site_user}@{server_ip}`).
- **Glanceable row markers.** `◆` marks sites with a linked local copy and `↑N`
  shows pending WordPress updates, across the Servers / Stacks / Search lists.
- **"Explain this screen."** Press `i` on any view for a plain-language guide to
  what each pane is and what every key does there.
- **Per-view subtitles** under the tab bar describing each screen and its key actions.

### Changed
- **Outcome-oriented key labels:** "detect" → "identify app", "scan local" →
  "find local copies", "upgrade PHP" → "change PHP".
- **Terminal actions open *your* terminal**, detected from `$TERM_PROGRAM` (e.g.
  iTerm), not a hardcoded Terminal.app; override with a `terminalApp` config/env value.
- **New config keys:** `localRoots` (folders to scan) and `localSites` (per-site
  link: path + local URL). The local URL is tool-agnostic (Valet, Cove, LocalWP,
  Herd, DDEV, …); an older `valetUrl` key is read and migrated automatically.

### Notes
- All new actions are read/local-only — no new SpinupWP API writes.
- "Open a terminal" and SSH script iTerm or Terminal on macOS; other terminals
  fall back to Terminal.app.

## [0.4.0] - 2026-06-18

### Added
- **Server actions: reboot + service restarts.** Press `a` on a server (Servers
  tab or a Search result) to reboot it (`POST /servers/{id}/reboot`) or restart a
  service — Nginx / PHP-FPM / MySQL / Redis (`POST /servers/{id}/services/{svc}/restart`).
  Pick → confirm → the event is tracked to completion in the store, so closing the
  overlay leaves it running and the server's row keeps a spinner (same model as PHP
  upgrades). Reboot's confirmation calls out whole-server downtime for all sites on
  it; a service restart is a brief blip. Needs a Read/Write token.
- **Reboot visibility + "why".** Servers needing a reboot show a `↻rbt` badge in the
  Servers list (the Dashboard already listed them). Because the API only exposes a
  `reboot_required` boolean with no reason, the actions overlay reads Ubuntu's
  `/var/run/reboot-required` + `.pkgs` over SSH (read-only, reusing the health
  connection) and shows the pending packages — typically a kernel/security update —
  labeled as OS-level context, not SpinupWP's internal logic. ServerDetail's
  "Reboot" field shows the same summary once probed.

## [0.3.0] - 2026-06-18

### Added
- **Upgrade a site's PHP version — the first write action.** Press `u` on a site
  (Servers / Stacks / Search) to pick a PHP version and apply it
  (`PUT /sites/{id}/php`); the resulting upgrade event is polled to completion.
  The picker is built dynamically from the (network-refreshed)
  [endoflife.date](https://endoflife.date) schedule — so new releases appear on
  their own — with the current version marked and EOL versions flagged; it is
  **not** filtered to versions already installed, since SpinupWP installs one on
  demand. Tracking lives in the app store, so closing the modal leaves the
  upgrade running: the site's row shows a spinner and target version (`→8.3`)
  until it settles (or flags `⬆!` on failure), and the detail panel mirrors the
  in-progress state. A site whose server has a pending platform upgrade is
  blocked with a pointer to the `w` web deep link.
- **Search actions mode.** In the Search tab, press `Tab` (or `→`) to hand focus
  from the search box to the selected result's action menu — `o` open, `w`
  SpinupWP, `u` PHP upgrade, `h` health — and `←` / `Esc` to return to typing.
- **Server upgrade visibility + SpinupWP deep links.** Servers with a pending
  SpinupWP platform upgrade show an `⬆upg` badge in the Servers list and a
  "SpinupWP upgrade" field in the detail panel. Press `w` to open the selected
  server (or site) directly in the SpinupWP web app — useful for actions the API
  can't perform, like running the upgrade. Requires `accountSlug` in config
  (`SPINUPWP_ACCOUNT_SLUG`); falls back to the dashboard root if unset.

### Changed
- **PHP EOL flagging is now date-driven, not a hard-coded version cutoff.** A
  version is flagged once its real end-of-life date is past the current date, so
  it self-corrects as the calendar advances (e.g. 8.2 flips on 2027-01-01 with
  no code change). Dates come from an embedded php.net table (offline default)
  refreshed from [endoflife.date](https://endoflife.date) and cached to
  `~/.config/spinupwp-tui/php-eol.json`; unknown versions are never guessed.

### Fixed
- The `upgrade_required` server field was mislabeled "OS upgrade"; it's a
  SpinupWP **platform** upgrade (not Ubuntu), now labeled accordingly.

### Notes
- The PHP upgrade is the first **write** feature and needs a SpinupWP
  **Read/Write** token. With a Read Only token the action returns a clear "token
  is read-only" message and nothing changes; the entire read path keeps working.

## [0.2.0] - 2026-06-18

### Added
- **Site stack detection + Stacks tab (Tier 1).** Classifies every site as
  Standard WP, Bedrock, or Non-WP from data already fetched (no SSH): non-WP →
  Non-WP, WP with a `/web/` webroot → Bedrock, any other WP → Standard WP. Adds
  a color-coded stack tag to the Servers and Search site lists, a "Stack" field
  in the site detail panel, and a new **Stacks** tab (key `3`) showing fleet
  composition (counts + bars), drill-down into the sites of a selected stack,
  and the fleet-wide PHP version distribution with end-of-life versions flagged.
- **Tier-2 stack probe (`d` / `D`).** On-demand, read-only SSH probe that
  inspects a site's filesystem to name what the API can't: WordPress (with
  version), Bedrock, WHMCS, Laravel, and Static HTML. `d` probes the selected
  site (in the Stacks and Servers tabs); `D` probes the entire selected stack,
  in list order, with bounded SSH concurrency. Detected results show in the
  Stacks list, the Non-WP breakdown, and the site detail panel.
- **Probe-aware composition.** A conclusive probe overrides the API's
  classification, so sites the API mislabels (e.g. WordPress installed outside
  SpinupWP's installer reports `is_wordpress=false`) move into their true
  bucket; counts shift toward reality as you probe. The Non-WP bucket expands
  into named sub-rows (WHMCS / Laravel / Static HTML / Unknown / unprobed).
- **Probe cache.** Results are cached to disk
  (`~/.config/spinupwp-tui/stack-cache.json`), hydrated at startup and written
  through (serialized) per probe, so detections survive restarts without
  re-running SSH.

### Changed
- Tab keys shifted to make room for Stacks: Search is now `4`, Events is `5`.

### Fixed
- Capital-letter shortcuts (`D`, and the previously-dead `G` jump-to-bottom) now
  register correctly — OpenTUI delivers letters lowercased with a shift flag, so
  key matching is normalized accordingly.

## [0.1.0] - 2026-06-18

Initial tagged release.

### Added
- Fleet dashboard: connection status, disk-usage bars, pending reboots/OS
  upgrades, WordPress update counts, and a recent activity feed.
- Server & site browser: three-pane navigator with full site details (PHP
  version, HTTPS, page cache, backups, Git deployment, WP updates).
- Global fuzzy search across every server and site by name, domain, or IP.
- Events feed with per-event detail and output.
- Live server health view (press `h`): CPU aggregate/per-core/sparkline, load,
  memory/swap, disk mounts, and top processes over SSH.
- Open-in-browser for sites (press `o`).
- Global `spinup` command with `login`, `where`, `help`, and `version`
  subcommands, plus first-run onboarding that validates and saves a token.

### Notes
- Read-only release: works with a SpinupWP **Read Only** API token.

[Unreleased]: https://github.com/mwender/spinupwp-tui/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/mwender/spinupwp-tui/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/mwender/spinupwp-tui/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/mwender/spinupwp-tui/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/mwender/spinupwp-tui/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/mwender/spinupwp-tui/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/mwender/spinupwp-tui/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mwender/spinupwp-tui/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/mwender/spinupwp-tui/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mwender/spinupwp-tui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mwender/spinupwp-tui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mwender/spinupwp-tui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mwender/spinupwp-tui/releases/tag/v0.1.0

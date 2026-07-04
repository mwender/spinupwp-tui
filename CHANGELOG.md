# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is in `0.x`, the public surface (CLI subcommands/flags, config
file location and format, and token-resolution behavior) may change between minor
versions; such changes are called out here.

## [Unreleased]

## [0.16.0] - 2026-07-04

### Added
- **Front-page check (`f` in the site-monitoring overlay) — site monitoring
  Phase 1.** Catches the failure plain up/down monitors sleep through: the page
  cache serving the *wrong page* while HTTP stays 200 (two real incidents showed
  a search-results template where the home page belonged). Instead of a
  hand-picked headline keyword — which breaks the day someone edits the copy —
  Spinup reads the live front page while it's healthy and derives a
  *template-identity* fingerprint (WP's `body_class()` output: `home` /
  `page-id-N` / `front-page`, falling back to the canonical link), validates it
  against a throwaway search render to prove it actually discriminates, and
  registers an Uptime Kuma keyword monitor asserting it. Check window is
  selectable (5m default · 15m · 30m · 1h — the fetch is served straight from
  the page cache, so even 5m costs the site nothing). Re-running `f`
  recalibrates the *existing* monitor row in place (history and notification
  wiring survive a redesign). A failing check surfaces as `WRONG PAGE SERVED`
  in the site's Details pane and the overlay.
- **`M` opens site monitoring from every site view.** Search and Stacks now bind
  capital `M` (their lowercase `m` was taken by media fallback); the Servers tab
  keeps `m` and gains `M` as an alias, so one muscle-memory key works everywhere.

- **Alert wiring from inside Spinup (`n` in the site-monitoring overlay).**
  Lists the notification providers actually configured in your Uptime Kuma —
  detected by name (e.g. "Telegram Alerts"), not assumed — and shows whether
  each is attached to this site's Spinup monitors (`✓` all / `◐` some / `○`
  none). `⏎` toggles a provider across all of the site's checks at once,
  editing each monitor in place (history, tags and other notification wiring
  survive). If Kuma has no providers yet, the overlay says so and points to
  Kuma → Settings → Notifications — creating the provider itself (bot tokens
  etc.) is the one step that stays in Kuma.

- **The site doctor (`d` in the site-monitoring overlay) — site monitoring
  Phase 2.** A read-only, zero-setup diagnosis of the "200 OK but wrong page"
  failure class, built on the cache differential: the page is fetched twice —
  once normally (cache-eligible) and once with the default
  `wordpress_no_cache` bypass cookie — and WP's template identity is compared
  between the two. SpinupWP's `fastcgi-cache: HIT/BYPASS` headers prove which
  layer answered each request, so a mismatch is *proof* the page cache is
  serving a different template than PHP renders (the purge-fixable condition),
  not a guess. Verdicts: healthy · stale-cache (with a copyable runbook —
  `wp elementor flush_css` appears only when Elementor is positively detected
  in the served markup, and that one command also purges SpinupWP's caches via
  the plugin's compat hook) · recalibrate (the page changed, not the cache —
  `f` jumps straight there) · **partial-outage** · down · inconclusive. Works
  without a Kuma connection, degrades honestly when the page cache is off, and
  never writes anything — diagnosis ends at the runbook by design.
- **The doctor catches partial outages cached-page monitors sleep through.**
  Two probes, two real failure shapes: (1) cached page 200 but a **fresh render
  throws 5xx** — verified live: with SpinupWP's default object-cache drop-in a
  dead Redis is *fatal* on every page-cache miss, and a plugin/theme fatal
  looks identical, so visitors see cached pages while admins, logged-in users
  and everything uncached fails; (2) the **wp-admin door probe** — the "site
  serves fine but wp-admin shows the critical-error screen" incident shape —
  fetches the login page (never page-cached; Bedrock's relocated `/wp/` login
  handled), where a 5xx means an admin-facing fatal. Hardened sites that hide
  or protect their login answer 401/403/404 and are reported as "can't judge",
  never false-alarmed. Both produce the `partial-outage` verdict with a runbook
  pointing at the site's error logs and the server's Redis monitor.
- **Server-wide Redis sentinel — site monitoring Phase 3a.** The vanity
  heartbeat cron gains a second marker-managed line: `redis-cli ping` every
  minute, pushed to a new `{server} redis` monitor in Kuma that alerts
  independently (and rides the `r` secret rotation like everything else).
  Registered automatically by `a`/`R` on a vanity site — after probing that
  Redis actually answers on that box, so a Redis-less server never gets a
  permanently-red monitor. A red sentinel while the server beats fine surfaces
  as `REDIS DOWN` on the server's Details row. Live-verified the full cycle on
  the test box: stop redis → down beat within the minute → restart → recovery
  beat. That test also surfaced why this matters more than expected: with
  SpinupWP's default object-cache drop-in, Redis being down is **fatal (HTTP
  500) for every request that misses the page cache** — cached pages keep
  serving 200, so page-watching monitors sleep through a real partial outage
  that this sentinel catches in a minute.

### Fixed
- **The site-monitoring overlay no longer gets stuck on a finished op's
  message.** A completed action's `✓`/`✕` result used to replace the action
  menu for the rest of the session — reopening the overlay showed only the old
  message, hiding `a`/`f`/`n` (the keys still worked, invisibly). Results now
  render above the menu, and a settled result is forgotten when the overlay
  closes, so it always reopens fresh.
- **Help/Explain overlays could deadlock open over a focused input.** Opening
  `?` or `i` in the beat before a view's text input grabbed focus (easy to hit
  by typing fast right after switching to Search) left an overlay that Esc
  couldn't close — the global handler bailed on `inputMode` before reaching the
  overlay's dismiss keys. Dismissal is now checked first.

## [0.15.0] - 2026-07-04

### Added
- **Rotate monitoring secrets (`r` in the `m` overlay, vanity sites).** Made for
  screencasts: record with the push URL or metrics-JSON key on screen, then press
  `r` right after and both secrets die. A new push token is edited into the
  *existing* Kuma push monitor — same monitor row, so heartbeat history, uptime
  stats and notification wiring all survive (no delete/re-create) — the heartbeat
  cron is rewritten to the new URL over SSH, a new health key is re-seeded into
  the vanity page, and any Kuma monitor URL still carrying the old key (the
  JSON-query recipe) is re-keyed automatically. Confirm-gated; works without a
  Kuma connection too (then just the health key rotates).
- **Vanity sites stand out in the Servers tab.** The server's own vanity/health
  page is marked with a `⌂` glyph and brand-green tint in the sites list — with
  servers named like domains (the vanity convention), it otherwise hides among
  regular sites.

## [0.14.0] - 2026-07-03

### Added
- **Uptime Kuma integration — monitors register themselves.** Connect your Kuma
  instance once (`m` on any site walks you through it; creds verified by a real
  login and stored 0600, or via `SPINUP_KUMA_URL`/`_USERNAME`/`_PASSWORD`) and:
  - The **vanity wizard grows two steps**: after publishing the page it registers
    a healthz monitor + a load push monitor in Kuma, then installs a once-a-minute
    heartbeat cron in the site user's crontab. The cron sends the 1-min load as
    the push `ping`, so Kuma graphs server load — and a silent cron (server down,
    cron dead, egress broken) flips the monitor: dead-man's-switch semantics.
    Both steps auto-skip when Kuma isn't connected, and a failure there is
    skippable — the site is already live.
  - **`m` on any site** manages monitoring in place: vanity sites get the full
    treatment (incl. `R` to re-publish pages seeded before the health-endpoint
    feature existed), regular sites get a homepage monitor (up/down + cert-expiry
    alerts) — client site files are never touched. **`R` works without Kuma
    too**: unconnected, it simply pushes the current page (a vanity-page
    refresh); connected, it also registers monitors + the cron. The connect
    form is opt-in (`c`), never a gate.
  - The client speaks Kuma's socket.io API (its only management API), adopts
    same-named monitors instead of duplicating them, reuses push tokens, and
    handles both Kuma 1.x and 2.x monitor schemas.
- **Kuma metrics live inside Spinup.** With a connection configured, the store
  polls Kuma once a minute and the data surfaces where you already look:
  - **Health view** gains a "Monitor (Uptime Kuma)" panel — up/down, 24h uptime %,
    a response-time sparkline, and a server-load sparkline fed by the heartbeat
    cron (real history that survives reopening the view, which the SSH-sampled
    CPU history can't).
  - **Details pane** shows a Monitor row per site (up/down + 24h uptime, or
    "not monitored · m"); the **header** shows a "▼ N monitors down" badge —
    only bad news earns header space.
  - **Reboots never page you**: firing a reboot first wraps the server's
    monitors in a Kuma maintenance window and removes it when the reboot event
    settles. Strictly best-effort — Kuma being unreachable never blocks the
    reboot — and the confirm screen says it's happening.
  - Load pushes are sent ×100 as integers (some Kuma builds silently drop float
    pings — found the hard way); Spinup's views scale them back.
- **Vanity pages are now health endpoints any uptime monitor can watch.** The page
  the `V` wizard seeds gains two machine modes: `?healthz` returns plain
  `200 ok` / `503 unhealthy: …` (1-min load per core > 2, or disk free < 10%) so a
  plain HTTP monitor gets resource alerting for free, and `?format=json&key=…`
  returns full metrics (load, cores, uptime, disk, memory, PHP version) guarded by
  a per-site key generated at seed time (shown on the wizard's done screen, kept in
  `vanityHealthKeys` in config.json so re-seeds keep monitor URLs stable). The
  human page and its WHMCS-parseable `<load>`/`<uptime>` tags are unchanged.
  Monitoring recipes — including Uptime Kuma keyword/JSON-query/cert-expiry
  setups — live in `docs/uptime-kuma.md`.

## [0.13.0] - 2026-07-03

### Added
- **A vanity site can now be added to a server that already has sites.** `V` was
  only offered on empty servers (its original "connect a fresh box" role), so a
  busy server had no way to get its hostname page + key-holding site user. The
  gate is now "does the server have a site at its own hostname yet" — and when
  it doesn't, a `V — Vanity site at hostname` row appears under Manage in the
  server's Details panel (or "Resume vanity-site build" for an unfinished one).
- **The DNS view can now repoint a record — press `p` to choose where it points.**
  Alongside the TTL editor, the `N` view's single-record editor gains a "Point
  at…" mode: pick from a list of your SpinupWP servers (name + IP, with the
  current one tagged) — pointing a record at one of your own boxes is what this
  is for — or enter a custom IP. Same confirm-before-firing flow as every other
  live write, and the change keeps applying in the background (Route 53 polls to
  INSYNC) if you close the editor. The inventory's VALUE column shows the
  in-flight repoint (`→ new IP`) and the settled value, mirroring the TTL cell.
  Guardrails carried over from the cutover work: a CNAME row explains it follows
  its target instead of opening, a Cloudflare *proxied* record repoints its
  origin (with a note that visitors keep resolving Cloudflare's IPs), a
  multi-value record warns it'll be collapsed to the one new value, and the
  NS-mismatch pre-flight blocks edits through a stale duplicate zone.
- **The clone wizard can now go back a screen with `←` (or `h`).** The setup
  steps (Plan ↔ Destination ↔ Connect dest ↔ Git access) step back freely —
  nothing has executed yet, so re-picking sites or the destination is safe.
  Once the per-site fan-out has fired, the one back edge is **DNS cutover →
  the clone roster**, so a verify can be re-run or a failed site retried
  before flipping live traffic. Cutover state survives the round trip: rows
  already checked, flipped, or mid-flight are never reset, and a site that
  becomes done via retry gets its DNS records read on re-entry.

### Fixed
- **The DNS view's `◀ here` marker is now always relative to the server you're
  viewing.** The "points here" flag was baked into each hostname's cached
  resolution at lookup time, relative to whichever server's inventory triggered
  it — so after checking DNS on the new server post-migration, reopening the
  view on the OLD server showed records that point at the new box flagged
  `◀ here` (with the wrong "N point here" tally). The cache now stores the
  resolved IPs neutrally and computes "here" at render against the current
  server; a just-repointed record also reads correctly immediately, before any
  refresh.
- **Clone verification no longer reports a cut-off read as a mismatch.** The
  source-vs-clone facts run as one wp-cli script per side; if it was
  interrupted partway (a timeout, or a plugin stalling on an outbound call),
  the missing tail rendered as `–` mismatch rows — reading as "the clone
  differs" when nothing had been compared. Verification now runs wp-cli with
  `--skip-plugins --skip-themes` (no plugin code stalls the read, and both
  sides use identical flags so every count stays comparable), allows the
  facts read twice the time, and a read that still comes back incomplete
  fails loudly as a verify error naming the side, instead of masquerading as
  differences.

## [0.12.0] - 2026-07-02

### Fixed
- **The clone wizard now detects each site's real webroot instead of assuming
  it.** The first clone of a long-lived production server failed every site:
  they all used a `/public/` public folder while the pull chain hardcoded
  `files/` as the webroot. And the `public_folder` *setting* alone can't be
  trusted either — SpinupWP never moves files when you configure one (its UI
  tells you to move them yourself). The Standard-WP pull now finds where
  WordPress actually lives on the source, and when a site is mid-move (core
  still at the files root, setting pointing deeper) the clone completes the
  move on the destination — placing `wp-config.php` one directory **above**
  the webroot, the long-standing config-outside-the-docroot hardening Spinup
  is deliberately opinionated about. Root-webroot sites keep the stock layout
  untouched; subdirectory installs clone as-is; anything unrecognizable
  refuses with a clear message instead of a mystery failure.
- **Sites SpinupWP marks as not-WordPress (redirect shells, static/PHP
  sites) now clone as "files only"** — opt-in in the Plan step (tagged, default
  off). The destination is created with no database, the whole files tree
  transfers verbatim over the same hardened transport (with byte progress),
  and verification compares file count, total size, and HTTP response instead
  of WordPress facts. Previously these sites failed mid-pull with a cryptic
  error; an interim fix merely excluded them.
- **Cloned databases keep the source's table prefix** — the destination DB
  was previously always created with `wp_`, breaking sites with custom
  prefixes.
- **Cloned sites now carry over the source's additional domains** (with their
  redirect settings). A freshly created site only answers for its primary
  domain, so `www.` and every extra hostname would have pointed at a server
  that didn't serve them after DNS cutover. The wizard now re-creates the
  full set on the destination right after the site is created — verified by
  the destination's nginx `server_name` picking up every hostname.

### Fixed (during live migration hardening)
- **Concurrent clones no longer sabotage each other's SSH.** The server-to-server
  pull authenticated every site with one shared temporary key, so with three
  sites in flight each site's setup/cleanup replaced or deleted the key the
  others were actively using — at most one site per run could survive. Each
  site now gets its own key, created and revoked independently.
- **A file changing on the live source mid-transfer no longer kills the whole
  site's clone.** tar reports "file changed as we read it" with a warning exit
  code that was being treated as fatal — and the wizard's own flags suppressed
  the message that would have explained it. Warnings are now tolerated (real
  transfer errors still fail) and logged with the exact file named.

- **Large file transfers no longer get killed by the wizard's own timeout.**
  A ~15-minute production pull was cut off at exactly 900s by two stacked
  timeouts — and the error surfaced a harmless tar warning instead of the
  real cause. The file-transfer budget is now 60 minutes, the outer session
  timeout strictly exceeds the in-script one, and an actual timeout says
  "file transfer timed out after 60 minutes" in so many words.
- **Manual DNS records in the cutover now show your access note** ("Delegate
  Access" by default, or whatever you've written for that zone) instead of
  wrongly telling you to connect an account for registrars that are managed
  by hand on purpose. API-connectable hosts (Cloudflare, Route 53) keep the
  actionable "connect an account" message.

### Changed
- **The DNS cutover screen grew real controls.** ↑↓ moves a cursor over the
  records; space includes/excludes any ready record from the batch flip
  (◉/◯, same as the Plan step); ⏎ on a record opens its zone's registrar
  web console with the zone name copied to the clipboard (the
  delegate-access flow); `c` cuts over exactly the included records; finish
  moved to `f`.
- **In-flight clone stages show a live elapsed timer** in the roster, so a
  long file pull reads as working rather than frozen.
- **File and database transfers show live byte progress** — the roster reads
  `pull · files · 1.2 GB · 18 MB/s · 4m32s` while a transfer runs. Measured
  by a read-only sidecar that stats the growing archive over its own SSH
  session every few seconds, so the progress display can never interfere
  with the transfer itself. File transfers show the Plan-measured size as a
  soft ceiling (`1.2 GB of ~2.9 GB` — approximate because the archive
  compresses in flight), and database pulls show a true percent (the dump
  is staged and gzipped on the source first, so its final size is a fact).
- **The clone wizard no longer jumps to DNS cutover on its own.** When the
  clone roster settles, the wizard now stays put so you can eyeball every
  site's final state — press `c` to continue to the cutover step (which moves
  live traffic) when you're ready.

### Added
- **Dev Mode (`SPINUP_DEV_MODE=1`).** Boots straight into the dashboard against
  a small in-memory example fleet — no API token, no network calls, nothing
  that can touch a real account. Every write action (PHP upgrade, HTTPS
  toggle, purge cache, reboot, create a server/site) behaves the same way it
  would against a real account — spinners, toasts, in-progress states — so
  it's useful for demos, screenshots, and UI work without a live account on
  hand. A purple `DEV MODE` badge in the header makes it unmistakable.
- **The API client is now rate-limit aware.** It watches
  `X-RateLimit-Remaining` on every response and paces itself as the window
  runs low, and a 429 is absorbed with a Retry-After backoff instead of
  surfacing as a failure. This matters: during a real migration, rate-limited
  polling made three *successful* operations report as failures. Event
  polling is also slower-cadence and tolerates transient API errors, and a
  genuinely failed domain-add now includes SpinupWP's own event output in the
  error.
- **Every clone job now writes a full log** to `~/.config/spinupwp-tui/logs/`
  (one JSONL file per job: every remote script, exit code, and complete
  output, with passwords redacted). Previously errors were truncated to the
  roster's width and lost when the app closed. Logs self-prune when a new
  job starts: anything older than 30 days or beyond the 20 most recent job
  logs is removed (copy a log elsewhere to keep it longer).
- **Press `⏎` on a failed site in the clone roster** to see the full
  untruncated error, the failing step, and the log path — and `r` there
  retries just that site.

## [0.11.0] - 2026-07-01

### Added
- **"What's new" release notes.** After Spinup updates to a new version, a
  one-time overlay shows what changed — sourced straight from that version's
  GitHub release (the same API the update-check hint already polls), so
  there's no separate feed to maintain. Shows once per version, dismisses with
  any key. Press `n` in `?` Help any time to replay the current version's notes.
- **Update in place with `u`.** When the gold `✦ vX.Y.Z` hint shows a newer
  release, open `?` Help and press `u` to `git pull --ff-only` right there —
  no more leaving the app to update manually. Refuses on a dirty checkout
  (never overwrites uncommitted work) or diverged history (never merges/
  rebases); since the running process can't hot-reload, it always tells you
  plainly to restart afterward, with a `bun install` nudge when dependencies
  changed. Manual `git pull` still works exactly as before.
- **Enable / disable HTTPS on a site (`H`).** The direction is auto-derived
  from the site's current state — press `H`, confirm, and it's done, tracked
  in the background the same way a PHP upgrade is. Disabling explicitly warns
  that https:// visitors will see errors until it's re-enabled.
- **Purge page + object cache (`P`).** SpinupWP has no enable/disable for
  either cache on an existing site (only at creation time) — purge is the one
  available write, so `P` fires both together under a single confirm and
  tracks them to completion. Low-risk and fully reversible by nature (both
  caches just rebuild on the next page load).

### Fixed
- **Cloudflare proxied records no longer block DNS cutover.** The clone
  wizard's cutover step used to mark every Cloudflare *proxied* (orange-cloud)
  record as "manual" — but a proxied record's TTL is what's actually
  uneditable (forced to automatic); its origin IP was always safely PATCHable
  through the same partial write already used for cutover. Proxied records now
  flow through the automatic batch flip like any other editable record; the
  TTL editor is unaffected and still correctly refuses to touch a proxied
  record's TTL.
- **Release notes overlay: text no longer overlaps on wrapped bullets.** The
  box's height was computed from logical line count, undercounting bullets
  that word-wrap into several visual rows — the box now sizes to whatever
  content actually renders instead.

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

[Unreleased]: https://github.com/mwender/spinupwp-tui/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/mwender/spinupwp-tui/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/mwender/spinupwp-tui/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/mwender/spinupwp-tui/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/mwender/spinupwp-tui/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/mwender/spinupwp-tui/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/mwender/spinupwp-tui/compare/v0.10.0...v0.11.0
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

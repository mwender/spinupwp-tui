# Site & server monitoring

Everything hangs off one overlay: press `m` on a site in any view (`M` is an
alias — the binding Search/Stacks use for something else, so the capital
works everywhere). It's a full-screen two-pane browser: a list of this
site's monitor kinds on the left (each with a live status dot), and a detail
pane on the right for whichever one is highlighted — a one-line definition,
how it actually works, live status, and the one action that applies to it.
It talks to your own [Uptime Kuma](https://github.com/louislam/uptime-kuma)
— Kuma watches 24/7 and sends the alerts; SpinupTUI creates the monitors
*correctly* and gives you an in-context glossary + diagnosis on demand.

## The monitor kinds

A regular site sees three:

- **Health check** — is this specific website up right now? A plain HTTP
  check on the site's own homepage, plus certificate-expiry alerting.
  Served straight from the page cache when one exists — cheap, but for
  that exact reason it can't see a PHP fatal hiding behind a still-warm
  cache.
- **Front page** — is the cache serving the right page? At setup, reads
  the live homepage and derives a template-identity fingerprint from
  whatever's actually there (a body-class token, or failing that the
  canonical link tag), then asserts it stays present at your chosen check
  window (5m/15m/30m/1h). Reads from the page cache too, so it catches the
  cache serving a stale/wrong template even though the page still answers
  200 — a failure the plain health check can't see. Shows as
  `WRONG PAGE SERVED` when it trips.
- **Cache bypass** — can PHP actually render this page *right now*? Same
  homepage URL, but with a `Cookie: wordpress_no_cache=1` header that
  forces the page cache to be skipped, so unlike the two checks above,
  this one genuinely exercises PHP on every check. That's also why it
  costs the site something (a full render each time) and is **opt-in**
  rather than automatic — a 30m/1h/2h/4h/6h window, defaulting to 1h —
  meant for sites with an actual history of PHP fatals hiding behind the
  cache, not the whole fleet.

A vanity/server site sees four:

- **Health check** — is the *server* itself under strain? Hits the vanity
  page's `/?healthz` endpoint (a small script reporting load/disk) and
  returns 503 when strained. This is about the server, not any one site —
  a customer site can be completely broken while this stays green, and the
  server can be strained while every site still limps out a 200.
- **Load heartbeat** — is the server itself still alive? A once-a-minute
  cron pushes its 1-minute load average to Kuma. Dead-man's-switch: the
  cron never reports down itself, it just goes silent if the
  server/cron/network egress dies, and Kuma's own missed-heartbeat timeout
  raises the alarm.
- **Redis sentinel** — is Redis actually answering? The same cron also
  runs `redis-cli ping` every minute and actively reports up/down —
  unlike the load heartbeat, this alerts immediately when Redis dies while
  the server itself is fine, since SpinupWP's default object-cache drop-in
  makes a dead Redis fatal on every page-cache miss.
- **PHP-fatal sentinel** — did any site on this server just start
  fataling? A root-level cron (needs sudo connected — press `S`) scans
  every site's error/debug logs each minute for new `PHP Fatal error`
  lines. Catches a fatal hiding behind a still-warm page cache that none
  of the checks above would ever notice. One monitor per server, not per
  site, to avoid a monitor pile-up across a large fleet — the specific
  affected domain is named in the down alert's own message.

## Using the overlay

`↑`/`↓` (or `j`/`k`) moves the highlight in the left list. `a` acts on
whichever monitor is currently selected:

- **Front page** selected → opens its check-window picker; re-running
  recalibrates the same monitor in place (history survives a redesign).
- **Cache bypass** selected → opens its check-window picker (registers on
  first use, since it's opt-in).
- **Anything else** (Health check / Load heartbeat / Redis sentinel /
  PHP-fatal) → registers or repairs. Safe to re-run any time — it re-syncs
  with Kuma, e.g. if a monitor was deleted directly in Kuma, or sudo just
  got connected (unlocking the PHP-fatal sentinel).

`x` removes the selected monitor — **only offered for Front page and Cache
bypass** (confirm-gated; deletes the Kuma monitor, history included).
The other four kinds don't offer it: they're all re-derived automatically
on the next `a`, so a delete would just silently reappear. If you need one
of those gone for good (e.g. a test site with no real DNS record, so its
health check can never succeed), **pause it directly in Kuma** instead —
a paused monitor is still "live" to SpinupTUI's adopt-or-create check, so
repairing the site again won't un-pause it or create a duplicate.

`o` opens the selected monitor's own page directly in Uptime Kuma (a deep
link to `<your-kuma-url>/dashboard/<id>`) — handy when Kuma's own list has
several similarly-named monitors and it's not obvious which is which.

`d` — the site doctor (regular sites, read-only, zero setup, works without
Kuma). It fetches the page twice — once normally, once with the
cache-bypass cookie — and lets the server's `fastcgi-cache: HIT/BYPASS`
headers prove which layer answered each request, then compares template
identity between the two. It also knocks on the wp-admin door (the login
page — never cached; Bedrock's relocated `/wp/` login handled). Verdicts:
healthy · stale-cache (with a copyable runbook) · **partial-outage**
(cached pages 200, fresh renders or wp-admin 5xx — Redis or a PHP fatal;
visitors look fine, admins are broken) · recalibrate · down · inconclusive.

`n` — alert wiring. SpinupTUI detects the notification providers
configured in your Kuma (by name — Telegram, email, whatever you've set
up) and shows whether each is attached to this site's monitors (`✓` all /
`◐` some / `○` none); `⏎` toggles a provider across all of the site's
checks at once. A passive **`Alerts: …`** line in the overlay's header
shows the same summary the moment you open it (fetched once per open, not
continuously polled), so you don't need to press `n` just to check.
Creating the provider (bot tokens etc.) is the one step that stays in
Kuma.

Vanity sites additionally get `R` (re-publish the page, then register
monitors + cron) and `r` (rotate the monitoring secrets — see
[docs/uptime-kuma.md](uptime-kuma.md)).

The design principle across all of it: **the page cache makes sites look
healthy while things break behind it** — every check watches either
*through* the cache on purpose (is the right thing being served?) or
deliberately *around* it (is the machinery behind it alive?).

See also [docs/uptime-kuma.md](uptime-kuma.md) for connecting Kuma and
the vanity-site health-endpoint recipes it's built on.

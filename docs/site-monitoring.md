# Site monitoring

Everything hangs off one overlay: press `M` on a site in any view (the Servers
tab also keeps its original `m`). It talks to your own
[Uptime Kuma](https://github.com/louislam/uptime-kuma) — Kuma watches 24/7 and
sends the alerts; SpinupTUI creates the monitors *correctly* and diagnoses on
demand.

- **`a` — uptime monitors.** Regular sites get a homepage monitor (up/down +
  cert-expiry). Vanity sites get the full server treatment: healthz + load
  push + a **Redis sentinel** — the heartbeat cron runs `redis-cli ping` every
  minute and reports up/down to a `{server} redis` monitor (registered only
  after probing that Redis actually answers on that box). Why it matters: with
  SpinupWP's default object-cache drop-in, a dead Redis is **fatal (HTTP 500)
  for every request that misses the page cache** — cached pages keep serving
  200, so only the sentinel notices, within a minute.
- **`f` — the front-page check.** SpinupTUI reads your *healthy* front page,
  derives a template-identity fingerprint from WordPress's own `body_class()`
  output (`class="home`, `page-id-N`, …, falling back to the canonical link),
  validates it against a throwaway search render to prove it discriminates,
  and registers a Kuma keyword monitor at your chosen window (5m default —
  the check is served straight from the page cache, so it costs the site
  nothing). A red check means "answering 200 but serving the WRONG page" —
  the stale/corrupt-page-cache incident — and shows as `WRONG PAGE SERVED` in
  Details. Re-running `f` recalibrates the same monitor in place (history
  survives a redesign).
- **`d` — the site doctor.** Read-only, zero setup, works without Kuma. It
  fetches the page twice — once normally, once with the cache-bypass cookie —
  and lets the server's `fastcgi-cache: HIT/BYPASS` headers prove which layer
  answered each request, then compares template identity between the two. It
  also knocks on the wp-admin door (the login page — never cached; Bedrock's
  relocated `/wp/` login handled). Verdicts: healthy · stale-cache (with a
  copyable runbook; the Elementor one-command flush is suggested only when
  Elementor is detected in the served markup) · **partial-outage** (cached
  pages 200, fresh renders or wp-admin 5xx — Redis or a PHP fatal; visitors
  look fine, admins are broken) · recalibrate (`f` jumps straight there) ·
  down · inconclusive.
- **`n` — alert wiring.** SpinupTUI detects the notification providers configured
  in your Kuma (by name — Telegram, email, whatever you've set up) and shows
  whether each is attached to this site's monitors (`✓` all / `◐` some / `○`
  none); `⏎` toggles a provider across all of the site's checks at once.
  Creating the provider (bot tokens etc.) is the one step that stays in Kuma.

The design principle across all of it: **the page cache makes sites look
healthy while things break behind it** — every check watches either *through*
the cache on purpose (is the right thing being served?) or deliberately
*around* it (is the machinery behind it alive?).

See also [docs/uptime-kuma.md](uptime-kuma.md) for connecting and configuring
Kuma itself.

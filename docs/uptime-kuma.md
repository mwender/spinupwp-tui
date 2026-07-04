# Monitoring vanity sites with Uptime Kuma

Every vanity site Spinup seeds (the `V` wizard) is also a machine-readable health
endpoint. This doc covers wiring those pages into [Uptime Kuma](https://github.com/louislam/uptime-kuma)
— though the endpoints are tool-agnostic and work with any HTTP monitor.

Examples use `web1.example.com` for the vanity site and `kuma.example.com` for the
Uptime Kuma instance; substitute your own.

## What the page exposes

| URL | Auth | Returns |
| --- | --- | --- |
| `https://web1.example.com/` | none | Human status page. `Online`, uptime, 1-min load (machine-parseable `<load>`/`<uptime>` tags — WHMCS-compatible). |
| `https://web1.example.com/?healthz` | none | `200 ok`, or `503 unhealthy: load disk` when 1-min load per core > 2 or disk free < 10%. Plain text. |
| `https://web1.example.com/?format=json&key=KEY` | `key` | Metrics JSON: `host, status, load_1m, cores, uptime_s, disk_free_pct, mem_available_pct, php_version, time`. `403` on a bad/missing key. |

The `key` is generated when the wizard seeds the page (shown on the wizard's done
screen; stored per domain under `vanityHealthKeys` in `config.json`). `?healthz`
deliberately needs no key — it reveals only a binary state, so it's safe for any
monitor, load balancer, or badge.

## Recipes

### 1. Server up/down + resource alerting in one monitor (recommended)

Monitor type **HTTP(s)** on `https://web1.example.com/?healthz`, accepted status
codes `200-299`, interval 60s. Because the page returns `503` under CPU pressure or
low disk, this single plain-HTTP monitor also alerts on resource trouble — no
special monitor type needed.

Kuma retries before alerting (default 1); bump **Retries** to 2–3 so a brief load
spike doesn't page you.

### 2. Keyword sanity check on the human page

Monitor type **HTTP(s) - Keyword** on `https://web1.example.com/` with keyword
`Online`. Exercises the full nginx → PHP-FPM path and confirms the page actually
renders. Mostly redundant with recipe 1; useful if you want to monitor the page a
visitor sees.

### 3. Certificate-expiry canary (free with any HTTPS monitor)

Any HTTPS monitor on the vanity site tracks its Let's Encrypt certificate. In Kuma:
Settings → Notifications, and enable **Certificate Expiry Notification** (defaults:
21/14/7 days). Since SpinupWP renews all LE certs on the server the same way, the
vanity cert doubles as a canary for server-wide renewal problems — you find out
without pointing monitors at client sites.

### 4. Custom thresholds with JSON Query monitors

Monitor type **HTTP(s) - Json Query** on
`https://web1.example.com/?format=json&key=KEY` lets you pick your own thresholds
instead of the baked-in healthz ones:

- Json Query `load_1m`, expected condition `< 8` — alert on sustained load.
- Json Query `disk_free_pct`, expected condition `> 10` — alert before disk fills.
- Json Query `status`, expected value `ok` — same semantics as healthz.

One monitor per expression (Kuma evaluates a single query each).

### 5. Response-time trend

Any of the above monitors also charts response time in Kuma. The page does real
PHP work per request, so its response-time graph loosely tracks server strain —
a useful early-warning trend line between hard alerts.

## Status pages and badges

Group vanity monitors on a Kuma **status page** (one entry per server) for an
at-a-glance fleet view you can share. Monitors shown on a status page also get
public badge URLs (`/api/badge/:id/status`, `/uptime`, `/cert-exp`, …) you can embed
anywhere.

## Let Spinup do it for you

Connect your Kuma instance once and Spinup registers monitors itself:

- **`m` on any site** (sites pane) opens the monitoring overlay. First use walks
  through connecting (URL + login, verified by actually logging in; stored in
  `config.json`, chmod 600 — or set `SPINUP_KUMA_URL`, `SPINUP_KUMA_USERNAME`,
  `SPINUP_KUMA_PASSWORD`). Then `a` registers monitors: vanity sites get the
  healthz monitor + a **load push monitor fed by a once-a-minute cron** in the
  site user's crontab. Kuma graphs the pushed value: 1-min load ×100 as an
  integer (164 = load 1.64 — some Kuma builds drop float pings; Spinup's own
  views scale it back). A silent cron — server down, cron dead, egress broken —
  flips the monitor: dead-man's-switch semantics. Regular
  sites get a homepage monitor; Spinup never touches a client site's files.
- **Vanity pages published before this feature** need one `R` (refresh) from the
  `m` overlay to gain the health endpoints, then everything above applies. `R`
  doesn't require a Kuma connection — unconnected it just re-publishes the
  current page; connected it also registers the monitors and cron in one go.
- **The vanity wizard (`V`) does all of this automatically** as its final two
  steps whenever a Kuma connection is configured.

Spinup adopts same-named monitors rather than duplicating them, so hand-made
monitors survive; a hand-made push monitor keeps its token (the cron adopts it).

## Rotating leaked secrets (screencast cleanup)

Two secrets can leak by simply being on screen: the push monitor's URL (Kuma
shows it in full on the monitor page) and the health key in a
`?format=json&key=…` monitor URL. Neither lets anyone *read* your metrics —
the push token only lets a sender **write** beats (fake "up"s masking a real
outage), and the health key gates the metrics JSON. If either has been shown
in a recording or screenshot, press **`r` in the `m` overlay** right after:

- A fresh push token is **edited into the existing push monitor** — same
  monitor row, so heartbeat history, uptime stats, and notification wiring
  survive (nothing is deleted or re-created) — and the heartbeat cron is
  rewritten to the new URL. The old push URL stops accepting beats immediately.
- A fresh health key is re-seeded into the vanity page (the old key starts
  returning `403`), and any Kuma monitor whose URL still embeds the old key
  (recipe 4 above) is re-keyed automatically.

Rotation is confirm-gated and works without a Kuma connection too — then only
the health key rotates, and the push token is left for when you connect.
Expect at most one or two missed heartbeats during the swap; the push
monitor's retries absorb them without alerting.

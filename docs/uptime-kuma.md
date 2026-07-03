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

## Roadmap

Deeper integration ships in later Spinup releases: registering these monitors
automatically from the vanity wizard, a per-server load graph via Kuma push
monitors (cron-fed, dead-man's-switch semantics), maintenance windows around
server reboots, and Kuma-backed uptime/response sparklines inside Spinup's Health
view.

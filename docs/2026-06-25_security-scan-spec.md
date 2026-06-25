# WP Site Security Scan — spec

Backlog item 14 (Planned, raised 2026-06-25). A graded security scorecard for a
WordPress site that runs **from inside the box** — over the SSH + WP-CLI access
Spinup already holds — and, where it can, **fixes what it finds** with one keypress.

Builds on: the write scaffolding from PHP upgrade (item 8, `mutate()`/`getEvent` +
the confirm overlay `ui/views/PhpUpgrade.tsx`), the SSH/WP-CLI orchestration in the
DB tooling (`src/lib/dbBackup.ts`/`dbSync.ts`, item 11), the stack detection (item
7), the linked local working copies (item 9), and the stacked progress readout
(v0.7.1).

## The product

> "Tell me, per site, how exposed I am right now — and let me fix the easy stuff
> without leaving the app."

Every mainstream WP scanner (Wordfence, Sucuri, MalCare) shares one structural
weakness: it scans from the outside, or it makes you install an **agent plugin**
inside the site. Spinup already has authenticated **SSH + WP-CLI** on every site of
every server, plus API-level server/site config, plus (for linked sites) a clean
local git checkout to diff against.

That makes Spinup's scan **agentless** — nothing to install — and lets it **close
the loop**: detect → *and remediate*, reusing machinery we already shipped. Every
other scanner stops at "here's a report." Detect-*and-fix* is the differentiator
and the clearest expression of the "SpinupWP IDE / daily driver" vision.

## MVP scope (user, 2026-06-25)

- **Tier 0 + Tier 1, plus one-press fixes from day one.** Read-only scan works on a
  read-only token; remediation degrades gracefully (greyed "needs write token").
- **Design the third-party API plumbing in now** (opt-in keys, like `localSync`),
  even though enrichment (Tier 3) ships in a later phase.
- Single-site scan first; fleet-wide scan is a later phase.

## What it checks, by access tier

**Tier 0 — SpinupWP API (no SSH; works on read-only token)**
- PHP version EOL/outdated (reuse stack detection)
- SSL cert present + expiry countdown; HTTPS forced/redirect
- Page-cache / basic-auth / firewall flags the API exposes
- Kernel-reboot-pending (reuse health view)

**Tier 1 — WP-CLI / SSH from inside (all reads)**
- `wp core verify-checksums` + `wp plugin verify-checksums` → modified core/plugin
  files (classic injection tell)
- `wp core/plugin/theme list --update=available` → outdated software (versions feed
  Tier 3 CVE matching)
- **wp-config hygiene:** unique salts, `DISALLOW_FILE_EDIT`, `WP_DEBUG` off in prod,
  non-default table prefix, perms on `wp-config.php`
- **User audit:** literal `admin` user, too many administrators, REST user
  enumeration open (`/wp-json/wp/v2/users`)
- **Exposed surface:** readable `debug.log`, `.git/`, `*.bak`, `readme.html` version
  leak, directory listing, `xmlrpc.php`
- **Malware heuristics (findings, not verdicts):** PHP files in
  `wp-content/uploads/`, `base64_decode`/`eval(`/`gzinflate` grep, files modified
  outside a deploy window
- **Persistence:** `wp cron event list` for injected events; suspicious admin rows
- **Drift via linked local copy:** diff the live tree against the clean git checkout
  (Bedrock especially) — gold-standard injected-file detection

**Tier 2 — HTTP surface (cheap, external)**
- Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options,
  Referrer-Policy); cookie flags (Secure/HttpOnly/SameSite); mixed content; version
  fingerprints

**Tier 3 — optional third-party APIs (opt-in, keyed; design now, ship later)**
- **Wordfence Intelligence CVE feed** (free) or **WPScan API** / **Patchstack** →
  authoritative CVE matching for the versions enumerated in Tier 1
- **SSL Labs API** (TLS grade); **Mozilla Observatory API** (header grade)
- **Sucuri SiteCheck / Google Safe Browsing / VirusTotal** (blacklist + remote
  malware); **Shodan** (exposed services on the server IP — fleet-level)

## Product shape (outcome-named, teaches in context)

A **Security view** showing a graded scorecard — A–F per category (Patches,
Hardening, Exposure, Integrity/Malware, TLS) — with findings sorted by severity.
Each finding states the risk in plain language and, where possible, carries a
**one-press fix** routed through the confirm overlay:

- "PHP 7.4 is end-of-life" → upgrade (already shipped)
- "5 plugins out of date, 2 with known CVEs" → update
- "File editing enabled in admin" → add `DISALLOW_FILE_EDIT`
- "`debug.log` is publicly readable" → fix perms / move it

## Hard rules

- **Confirm-before-prod-writes** applies to every remediation and to any heavy scan
  read; nothing mutates a production site without explicit confirmation.
- Integrity/malware results are **findings with a confidence level**, never
  verdicts — avoid false-positive panic.
- Third-party keys are opt-in; **anonymize client domains** in any artifact.
- Checksums over SSH are slow on big sites → drive the stacked progress readout.

## Phasing

1. **MVP** — Tier 0 + Tier 1 scan, graded scorecard, **one-press fixes** wired via
   `mutate()` + confirm overlay. Third-party key plumbing scaffolded but dormant.
2. **CVE/grade enrichment** — light up opt-in Wordfence/WPScan + SSL Labs +
   Observatory.
3. **Fleet + history** — scan all sites on a server; store last-scan; flag drift
   over time.

## Open questions (resolve before build)

- Exact key/route for the Security view (avoid collisions with `s` post-import hook,
  `d`/`p`/`m`).
- Where scan results/history persist (per-site, in `~/.config/spinupwp-tui/`?).
- Whether the scan is on-demand only or also runs ambiently on site selection.

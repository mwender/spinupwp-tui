# Stack detection

The **Stacks** tab (`3`) breaks your fleet into buckets and helps you see what's
actually running where. It works in two tiers:

- **Tier 1 — instant, no SSH.** Every site is classified from data the API
  already returns: **Non-WP**, **Bedrock** (WordPress with a `/web/` webroot), or
  **Standard WP**. The left pane shows counts and bars; the right pane shows the
  fleet-wide **PHP version distribution** with end-of-life versions flagged.
  **Radicle** (Roots' Bedrock+Sage+Acorn starter) isn't in this tier — its
  `/public/` webroot is indistinguishable at a glance from a hardened Standard-WP
  `/public/` layout, so it only surfaces once Tier 2 confirms it.

- **Tier 2 — on-demand SSH probe.** Press `d` on a site (Stacks tab) or `f`
  (Servers / Search tabs) to inspect its filesystem **read-only** and identify it
  precisely: **WordPress** (with version), **Bedrock**, **Radicle**, **WHMCS**,
  **Laravel**, or **Static HTML**. Press `D` to probe an entire stack in list
  order (bounded SSH concurrency). A conclusive probe **overrides** the Tier-1
  guess — so a site the API mislabels (e.g. WordPress installed outside
  SpinupWP's installer reports `is_wordpress=false`) moves into its true bucket.
  Radicle is distinguished from Bedrock by its `roots/acorn` Composer dependency
  — a bare `roots/bedrock` string match isn't enough, since Radicle also pulls
  in `roots/bedrock-autoloader`. The Non-WP bucket expands into named sub-rows
  (WHMCS / Laravel / Static HTML / Vanity Site / Unknown / unprobed).

**Vanity Site** is the one Non-WP sub-row that needs no probe. A site whose domain is its server's own hostname (e.g. `web1.example.com` on server `web1.example.com`) is the server's vanity site, the same rule every vanity feature uses, so it's known from the API alone. It claims the site when the probe is absent, Unknown or Static HTML, since the placeholder page reads as neither; a positively identified app (WHMCS, Laravel) living at the hostname keeps its own row, and a WordPress site at the hostname stays in its WordPress bucket.

Probes reuse the same SSH access as the health view (`site_user@ip`, your local
keys, `BatchMode`) and are **read-only**. Results are cached to
`~/.config/spinupwp-tui/stack-cache.json` (per account — see [multiple-accounts.md](multiple-accounts.md)), hydrated at startup, so detections
survive restarts without re-running SSH.

**WordPress versions refresh themselves.** A site's stack rarely changes, but its WordPress version does, through auto-updates, wp-admin or a deploy, and none of those go through SpinupTUI. So a version reading older than a day is re-checked in the background whenever the site list loads (at launch and on `r`), for sites that have been identified before. Each server's sites are checked one at a time, and the first failure on a server stops that server's checks until the next day, so unattended SSH can't trip fail2ban on a site whose key has been removed. A site whose re-check fails keeps its last reading, marked with its age (`WordPress 6.9.4 4mo`) in the Stacks list. The Details pane always shows when the reading was taken.

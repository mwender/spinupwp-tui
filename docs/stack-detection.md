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
  (WHMCS / Laravel / Static HTML / Unknown / unprobed).

Probes reuse the same SSH access as the health view (`site_user@ip`, your local
keys, `BatchMode`) and are **read-only**. Results are cached to
`~/.config/spinupwp-tui/stack-cache.json`, hydrated at startup, so detections
survive restarts without re-running SSH.

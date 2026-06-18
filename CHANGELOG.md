# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is in `0.x`, the public surface (CLI subcommands/flags, config
file location and format, and token-resolution behavior) may change between minor
versions; such changes are called out here.

## [Unreleased]

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

[Unreleased]: https://github.com/mwender/spinupwp-tui/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/mwender/spinupwp-tui/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mwender/spinupwp-tui/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mwender/spinupwp-tui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mwender/spinupwp-tui/releases/tag/v0.1.0

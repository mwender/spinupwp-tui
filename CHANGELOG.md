# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is in `0.x`, the public surface (CLI subcommands/flags, config
file location and format, and token-resolution behavior) may change between minor
versions; such changes are called out here.

## [Unreleased]

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

[Unreleased]: https://github.com/mwender/spinupwp-tui/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mwender/spinupwp-tui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mwender/spinupwp-tui/releases/tag/v0.1.0

# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is in `0.x`, the public surface (CLI subcommands/flags, config
file location and format, and token-resolution behavior) may change between minor
versions; such changes are called out here.

## [Unreleased]

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

[Unreleased]: https://github.com/mwender/spinupwp-tui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mwender/spinupwp-tui/releases/tag/v0.1.0

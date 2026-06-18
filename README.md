<p align="center">
  <img src=".github/assets/banner.png" alt="SpinupWP TUI" width="100%">
</p>

<h1 align="center">SpinupWP TUI</h1>

<p align="center">
  A fast, keyboard-driven terminal dashboard for browsing and monitoring your
  <a href="https://spinupwp.com">SpinupWP</a> servers and sites.<br>
  Built with <a href="https://opentui.com">OpenTUI</a> and <a href="https://bun.sh">Bun</a>.
</p>

Once you're in, the dashboard looks like this:

```
 ◆ SpinupWP   1 Dashboard   2 Servers   3 Stacks   4 Search   5 Events   20 servers · 171 sites

 ┌──────────────┐ ┌───────────────┐ ┌───────────────────┐ ┌──────────────────────┐
 │ Servers      │ │ Sites         │ │ Fleet Disk        │ │ WP Updates           │
 │ 20           │ │ 171           │ │ 22%               │ │ 359                  │
 │ 20 connected │ │ 139 WordPress │ │ 616.3 GB / 2.8 TB │ │ 217 plugin · 67 core │
 └──────────────┘ └───────────────┘ └───────────────────┘ └──────────────────────┘
 ┌─ Disk usage by server ───────────────┐ ┌─ Needs attention (27) ──────────────┐
 │ web1.example.com       ██████░░░ 60% │ │ • db1.example.com — …               │
 │ web2.example.com       ██████░░░ 57% │ │ • web3.example.org — OS …           │
 └──────────────────────────────────────┘ └─────────────────────────────────────┘
```

## Features

- **Fleet dashboard** — at-a-glance health of every server: connection status,
  disk usage bars, pending reboots/OS upgrades, WordPress update counts, and a
  recent activity feed.
- **Server & site browser** — a three-pane navigator. Pick a server, see its
  sites, drill into full details (PHP version, HTTPS, page cache, backups, Git
  deployment, WP updates, and more).
- **Stack detection & fleet composition** — the Stacks tab classifies every site
  as Standard WP, Bedrock, or Non-WP, with a fleet-wide PHP version breakdown
  (EOL versions flagged). Press `d` to SSH-probe a site's actual stack — naming
  WHMCS, Laravel, Static HTML, and WordPress versions the API can't tell you —
  or `D` to probe a whole stack at once. (See "Stack detection" below.)
- **Global search** — fuzzy search across every server and site at once by name,
  domain, or IP. Tab onto a result to act on it (open, SpinupWP, PHP upgrade,
  health) right from the results, without leaving the search.
- **Events feed** — recent provisioning and operation activity, with per-event
  detail and output.
- **Live server health** — press `h` on any server for a real-time view over
  SSH: CPU (aggregate + per-core + sparkline), load, memory/swap, disk mounts,
  and top processes. Polls every few seconds. (See "Server health" below.)
- **Open in browser** — press `o` on any site to open it in your default browser.
- **Upgrade a site's PHP version** — press `u` on a site to pick a new PHP
  version and apply it (`PUT /sites/{id}/php`), then watch the upgrade event run
  to completion. (See "Upgrading PHP" below.)

> The tool is **read-only by default** and works great with a Read Only API
> token. The one write action — upgrading a site's PHP version — needs a
> **Read/Write** token; everything else keeps working without one.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3 (OpenTUI uses Bun's native FFI). Install with:
  ```sh
  curl -fsSL https://bun.sh/install | bash
  ```
- A SpinupWP API token — create one at
  [spinupwp.app/account/api](https://spinupwp.app/account/api/). **Read Only**
  scope is enough to browse; use **Read/Write** if you want to upgrade a site's
  PHP version.

## Install & run

```sh
git clone <this-repo> spinupwp-tui
cd spinupwp-tui
bun install
bun run start
```

On first launch, if no token is configured you'll be guided through a short
onboarding flow that validates your token and saves it locally.

### Run `spinup` from anywhere

Install the `spinup` command globally with a symlink to this checkout (updates as
you pull):

```sh
bun run link-global      # = bun link; creates `spinup` on your PATH
spinup login             # save your API token to the config file (once)
spinup                   # launch from any directory
```

`spinup login` is what makes it work outside the project: the project `.env` is
only read from the project directory, so the global command relies on the token
saved in the config file. (Run `bun run unlink-global` to remove the command.)

For a standalone binary that doesn't need Bun on `PATH` at runtime:

```sh
bun run build:binary     # produces ./spinup — move it onto your PATH
```

#### CLI subcommands

```
spinup            Launch the dashboard
spinup login      Set or update your saved API token
spinup where      Show the config path and which source the token came from
spinup --version  Print the version
spinup --help     Show help
```

## Configuration

The token is resolved in this order (first match wins):

1. **`SPINUPWP_ACCESS_TOKEN`** environment variable. Bun automatically loads a
   `.env` file from the working directory, so a project-local `.env` works:
   ```sh
   # .env
   SPINUPWP_ACCESS_TOKEN=your-token-here
   ```
2. **`~/.config/spinupwp-tui/config.json`** — written by the onboarding wizard.
   Respects `XDG_CONFIG_HOME`.

To reconfigure, delete the config file (the path is shown on the onboarding
screen) and relaunch, or set the environment variable.

### Optional settings

Both can be set in `config.json` or via an environment variable:

- **`accountSlug`** / `SPINUPWP_ACCOUNT_SLUG` — your SpinupWP account/team slug
  (the first path segment in a SpinupWP URL, e.g. `wenmark-digital-solutions` in
  `https://spinupwp.app/wenmark-digital-solutions/servers/35633`). The API
  doesn't expose it, so set it to enable the `w` deep links into the web app.
  Without it, `w` opens the SpinupWP dashboard root.
- **`sshUser`** / `SPINUPWP_SSH_USER` — override the SSH user for the health view
  and stack probes (see "Server health" below).

## Keybindings

| Key | Action |
| --- | --- |
| `1`…`5` | Switch tabs: Dashboard · Servers · Stacks · Search · Events |
| `↑`/`↓` or `j`/`k` | Move selection |
| `Enter` / `→` | Drill in (server → its sites) |
| `←` / `Esc` | Go back / collapse |
| `Tab` | Switch focus between columns |
| `g` / `G` | Jump to top / bottom |
| `o` | Open the selected site in your browser |
| `h` | Live server health (CPU/mem/disk over SSH) |
| `d` | Detect a site's stack via SSH (Servers / Stacks tabs) |
| `D` | Detect every site in the selected stack (Stacks tab) |
| `u` | Upgrade a site's PHP version (Servers / Stacks / Search; needs a Read/Write token) |
| `w` | Open the selected server/site in the SpinupWP web app |
| `/` | Jump to global search |
| `r` | Refresh data from the API |
| `?` | Toggle the help overlay |
| `q` / `Ctrl+C` | Quit |

In the **Search** tab the box keeps keyboard focus while you type. Press **Tab**
(or **→**) to hand focus to the selected result's **action menu** — `o` / `w` /
`u` / `h` then act on that server or site — and **←** / **Esc** to return to the
search box.

## Server health (SSH)

The SpinupWP API exposes no live metrics, so the health view (`h` in the
Servers tab) reaches the server directly over SSH using **your local SSH keys /
agent** — the same way you'd `ssh in` and run `htop`. It runs a single batched,
**read-only** command (`cat /proc/*`, `df`, `ps`) and renders the result.

- **Connection target** is derived from the API: it connects as one of the
  server's `site_user`s at the server's IP (`site_user@ip`). No extra config
  needed if `ssh site_user@ip` already works from your terminal.
- **Non-interactive:** it uses `BatchMode=yes`, so if key auth isn't already set
  up it fails fast with a hint rather than prompting for a password.
- **Override the SSH user** (e.g. to use `root` or a sudo user) with the
  `SPINUPWP_SSH_USER` environment variable, or `"sshUser"` in the config file.
- A persistent `ControlMaster` connection keeps repeated polls fast.

Nothing is ever written to the server.

## Stack detection

The **Stacks** tab (`3`) breaks your fleet into buckets and helps you see what's
actually running where. It works in two tiers:

- **Tier 1 — instant, no SSH.** Every site is classified from data the API
  already returns: **Non-WP**, **Bedrock** (WordPress with a `/web/` webroot), or
  **Standard WP**. The left pane shows counts and bars; the right pane shows the
  fleet-wide **PHP version distribution** with end-of-life versions flagged.

- **Tier 2 — on-demand SSH probe.** Press `d` on a site (in the Stacks or
  Servers tab) to inspect its filesystem **read-only** and identify it precisely:
  **WordPress** (with version), **Bedrock**, **WHMCS**, **Laravel**, or
  **Static HTML**. Press `D` to probe an entire stack in list order (bounded SSH
  concurrency). A conclusive probe **overrides** the Tier-1 guess — so a site the
  API mislabels (e.g. WordPress installed outside SpinupWP's installer reports
  `is_wordpress=false`) moves into its true bucket. The Non-WP bucket expands
  into named sub-rows (WHMCS / Laravel / Static HTML / Unknown / unprobed).

Probes reuse the same SSH access as the health view (`site_user@ip`, your local
keys, `BatchMode`) and are **read-only**. Results are cached to
`~/.config/spinupwp-tui/stack-cache.json`, hydrated at startup, so detections
survive restarts without re-running SSH.

## Upgrading PHP

Press `u` on a selected site (in the **Servers** or **Stacks** tab) to change its
PHP version. A picker lists the available versions — the current one is marked,
end-of-life versions are flagged, and the list is sourced from the live PHP
release schedule (so new versions like 8.5 appear automatically). After you
confirm, the app calls `PUT /sites/{id}/php` and polls the resulting event until
it finishes.

- **Needs a Read/Write token.** SpinupWP exposes no token-scope endpoint, so a
  read-only token is detected when the upgrade comes back `403` — you'll get a
  clear "token is read-only" message and nothing changes. Swap in a Read/Write
  token (`spinup login`) to actually apply upgrades.
- **On-demand install.** If the chosen version isn't installed on the server yet,
  SpinupWP installs it first; the event simply takes a little longer.
- **Pending platform upgrade.** If the site's server has a pending SpinupWP
  platform upgrade, it can't be managed via the API until that runs — the picker
  is blocked and points you to open the server in the web app (`w`).
- **Runs in the background.** The upgrade is tracked in the app's store, so you
  can press `Esc` to close the modal and it keeps going — the site's row shows a
  spinner and the target version (`→8.3`) until it settles, then refreshes to the
  new version (or flags `⬆!` if it failed). The SiteDetail "PHP" field shows the
  same in-progress state. You can launch upgrades on several sites at once.

## Development

```sh
bun run dev          # run from source
bun run typecheck    # tsc --noEmit
```

### Project layout

```
src/
  index.tsx          entry — boots OpenTUI, routes onboarding vs app
  config.ts          token resolution + persistence
  api/
    client.ts        typed fetch client (reads + writes, errors, validation)
    types.ts         Server / Site / Event types
  lib/               formatting, theme, open-in-browser, SSH helpers
    stack.ts         Tier-1 stack classification + effective (probe-aware) bucket
    probe.ts         Tier-2 SSH stack probe (WHMCS / Bedrock / Laravel / WP / …)
    stackCache.ts    disk-backed probe cache (hydrate on start, write-through)
    phpEol.ts        PHP EOL dates + the version set offered by the upgrade picker
  ui/
    App.tsx          shell: splash gating, key routing, layout
    store.tsx        React-context data store
    Splash / Onboarding / Header / StatusBar / Help
    List.tsx         generic windowed keyboard list
    Details.tsx      shared server/site detail panels
    views/           Dashboard, Browser, Stacks, Search, Events, Health, PhpUpgrade
```

## License

MIT — see [LICENSE](LICENSE).

<p align="center">
  <img src=".github/assets/banner.png" alt="SpinupWP TUI" width="100%">
</p>

<h1 align="center">Spinup</h1>

<p align="center">
  A fast, keyboard-driven terminal control center for your
  <a href="https://spinupwp.com">SpinupWP</a> account — browse and monitor your
  servers and sites, and run local-dev workflows against them.<br>
  Built with <a href="https://opentui.com">OpenTUI</a> and <a href="https://bun.sh">Bun</a>.
</p>

Once you're in, the dashboard looks like this:

```
 ◆ Spinup v0.9.0   1 Dashboard   2 Servers   3 Stacks   4 Search   5 Events   20 servers · 171 sites

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
  disk usage bars, pending reboots/SpinupWP platform upgrades, WordPress update
  counts, and a recent activity feed. Servers running an **end-of-life Ubuntu
  release** are flagged too — a `⚠ os` badge in the Servers list, a red "Ubuntu …
  EOL" line in a server's detail panel, and an entry in the dashboard's "Needs
  attention" list pointing at the clone wizard (`C`).
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
- **Link local working copies** — press `L` on a site to link its local checkout
  (a path plus the local URL where you serve it), then open it with `t` (a
  terminal there) or `v` (its local URL). The Stacks tab can **auto-discover**
  copies (`S`) by git remote / Bedrock `WP_HOME` / folder name, and **report**
  managed sites that still need one (`f`). Linked sites show a `◆` marker, and a
  linked checkout shows its local git drift (`⇡N unpushed` / `● uncommitted`).
  (See "Local working copies" below.)
- **SSH into a site** — press `s` on a site to open a new terminal already running
  `ssh` into it (`{site_user}@{server_ip}`).
- **DNS migration lens** — press `n` on a site (or `N` on a server) to see the DNS
  records that move a site to another server: each site's hostnames with their type,
  TTL (in seconds), and a `◀ here` flag when they point at this server. Connect a
  provider (AWS Route 53 / Cloudflare) and press `⏎` to **edit a record's TTL** — the
  prep step for a low-risk cutover. It only ever touches a site's own hosting records,
  never your MX/TXT/other records. (See "DNS hosts, access & editing" below.)
- **Database backup & sync** — on a linked WordPress site (Search tab), press `d`
  to download a gzipped production database backup into the copy's `sql/` folder
  (**read-only on production**), or — opt-in — press `p` to pull production into
  your **local** database (backs up local first, rewrites URLs, runs your existing
  `sync.d` hook). Works with Standard WP and Bedrock, no per-site config. (See
  "Database backup & sync" below.)
- **Production media fallback** — after a DB pull, your local site shows broken
  images because the (often huge) media library isn't synced. Press `m` on a
  linked WordPress site to drop a small mu-plugin that serves any **missing-locally**
  upload from production — so images resolve without copying a single file. Works
  on any local stack (it's pure PHP, not web-server config). (See "Production media
  fallback" below.)
- **Upgrade a site's PHP version** — press `u` on a site to pick a new PHP
  version and apply it (`PUT /sites/{id}/php`), then watch the upgrade event run
  to completion. (See "Upgrading PHP" below.)
- **Enable / disable HTTPS** — press `H` on a site to toggle its certificate.
  Enabling issues a free Let's Encrypt cert (the domain must already resolve to
  the server); disabling removes it — the confirm screen warns plainly that
  https:// visitors will see errors until it's re-enabled. Same background
  event-tracking as the PHP upgrade.
- **Server actions** — press `a` on a server to reboot it or restart a service
  (Nginx / PHP-FPM / MySQL / Redis). Servers needing a reboot show a `↻rbt`
  badge, and the overlay reads the box over SSH to show *why* (the pending
  kernel/security packages). (See "Server actions" below.)
- **Create & connect a server** — press `c` on the Servers tab to provision a new
  server (DigitalOcean / Vultr / Linode / Hetzner), priced from the provider catalog
  and pre-filled to match a selected server. Then press `V` on a server with **no
  sites** to connect it end to end: Spinup writes the DNS A record, creates a
  placeholder "vanity" site, enables HTTPS, hands you off to add your SSH key, and
  publishes a status page — turning a bare server into one you can actually work
  with. Long builds run in the background and survive a restart. (See "Creating &
  connecting servers" below.)
- **Clone a whole server to a new one** — press `C` on a server to clone one or
  more of its sites onto a fresh (or existing) destination, **without touching DNS
  until you say so**. A guided wizard plans + sizes the sites, provisions or picks
  the destination, pulls each site server-to-server (Standard WP **and** Bedrock),
  verifies the clone against the source, and finally repoints DNS on your word.
  Runs in the background with a header badge. (See "Cloning a server" below.)
- **Privileged writes over SSH (sudo + SSH keys)** — the SpinupWP API can't manage
  SSH keys or sudo users, so Spinup does it directly. Press `S` on a server to
  **connect sudo** for the session (optionally **remembered in your macOS Keychain**
  so it auto-unlocks next time), then `K` on a site to **grant or revoke** your
  personal key and/or Spinup's dedicated machine key — one site or every site on the
  server. (See "Privileged writes over SSH" below.)
- **Completion toasts** — background writes that take a while (a PHP upgrade, a
  server reboot/restart, resolving your fleet's DNS) raise a non-focus-stealing
  toast when they finish, so you're not left guessing after you've moved on.
- **Release notes** — after Spinup updates to a new version, a one-time overlay
  shows what changed (sourced straight from that version's GitHub release —
  no separate feed to maintain). Press `n` in `?` Help to see the current
  version's notes again any time.

> The tool is **read-only by default** and works great with a Read Only API
> token. The write actions — creating a server, connecting it with a vanity site,
> cloning a server, upgrading a site's PHP version, and rebooting / restarting
> services — need a **Read/Write** token. The SSH actions (sudo connect, grant key,
> clone pull) use **your own SSH access**, not the API token; everything else keeps
> working without any of it.

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

### Updating

The app tells you when a newer release exists — a gold `✦ vX.Y.Z` appears next
to the version in the header (and in the `?` About panel). From there, press
**`u`** to update in place (`git pull --ff-only` in your checkout; refuses if
you have uncommitted changes, and never merges/rebases). It can't hot-reload
the already-running process, so it tells you plainly when to restart — press
`q`, then relaunch `spinup`. **If the update changed dependencies, it tells you
to run `bun install` too** before restarting.

Prefer to do it by hand? `git pull` in your checkout works the same way — the
global `spinup` symlink picks up the new code immediately. A standalone binary
needs a fresh `bun run build:binary` either way.

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

These can be set in `config.json` or via an environment variable:

- **`accountSlug`** / `SPINUPWP_ACCOUNT_SLUG` — your SpinupWP account/team slug
  (the first path segment in a SpinupWP URL, e.g. `wenmark-digital-solutions` in
  `https://spinupwp.app/wenmark-digital-solutions/servers/35633`). The API
  doesn't expose it, so set it to enable the `w` deep links into the web app.
  Without it, `w` opens the SpinupWP dashboard root.
- **`sshUser`** / `SPINUPWP_SSH_USER` — override the SSH user for the health view
  and stack probes (see "Server health" below).
- **`localSync`** / `SPINUPWP_LOCAL_SYNC` — opt-in for the **Pull production →
  local** DB sync (`p`); off by default because it overwrites your local database.
  **Prefer `"localSync": true` in `config.json`** — it's read from a fixed path
  (`~/.config/spinupwp-tui/config.json`) so it applies wherever you launch `spinup`
  from. The environment variable works too, but note a `.env` is only loaded when
  you launch from the directory that contains it (Bun reads `.env` from the current
  working directory, not from where the installed command lives) — so a repo or
  project `.env` won't take effect for the globally-installed `spinup` run from
  elsewhere. For a persistent, location-independent setting, use `config.json`.

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
| `s` | Open a terminal and SSH into the selected site |
| `d` | Download a production DB backup into the linked copy (Search; WordPress + linked) |
| `p` | Pull the production DB into the linked copy — overwrites local; opt-in via `localSync` (Search) |
| `m` | Production media fallback: serve missing-locally images from production (Search; WordPress + linked) |
| `L` | Link / edit a site's local working copy |
| `t` / `v` | Open the linked copy in a terminal / its local URL in your browser |
| `n` | DNS migration view for a site — its records + TTLs (`⏎` edits a TTL; `a` shows the whole server) |
| `N` | DNS migration view for the whole server |
| `h` | Live server health (CPU/mem/disk over SSH) |
| `d` | Detect a site's stack via SSH (Servers / Stacks tabs) |
| `D` | Detect every site in the selected stack (Stacks tab) |
| `S` | Auto-discover & batch-link local copies (Stacks tab) |
| `f` | Report sites with no usable local copy (Stacks tab) |
| `u` | Upgrade a site's PHP version (Servers / Stacks / Search; needs a Read/Write token) |
| `H` | Enable / disable HTTPS on a site (Servers / Stacks / Search; needs a Read/Write token) |
| `a` | Server actions: reboot / restart a service (Servers / Search; needs a Read/Write token) |
| `c` | Create a new server (Servers tab; needs a Read/Write token) |
| `V` | Connect a 0-site server with a vanity site — DNS + site + HTTPS + SSH-key handoff (Servers tab; needs a Read/Write token) |
| `C` | Clone a server's sites to a new/existing destination (Servers tab; needs a Read/Write token + sudo) |
| `S` | Connect sudo on a server for privileged writes — optionally remembered in the macOS Keychain (Servers tab) |
| `K` | Grant / revoke an SSH key on a site, or every site on the server (needs sudo connected) |
| `w` | Open the selected server/site in the SpinupWP web app |
| `/` | Jump to global search |
| `r` | Refresh data from the API |
| `i` | Explain the current screen (what each pane and key does) |
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
  same in-progress state. You can launch upgrades on several sites at once. When an
  upgrade finishes, a **toast** confirms it (`example.com upgraded to PHP 8.3`) —
  useful since it often completes after you've closed the modal and moved on.

## Server actions

Press `a` on a selected server (in the **Servers** tab, or a result in **Search**)
to open the server-actions overlay: **reboot** the server, or **restart** a single
service (Nginx / PHP-FPM / MySQL / Redis). Pick → confirm → the app calls
`POST /servers/{id}/reboot` or `/services/{svc}/restart` and tracks the event to
completion — same background behavior as PHP upgrades (close the overlay and the
server's row keeps a spinner).

- **Needs a Read/Write token** (like PHP upgrades).
- **Reboot visibility.** Servers with a pending reboot show a `↻rbt` badge in the
  Servers list and on the Dashboard's "Needs attention" panel.
- **Why a reboot is pending.** The API only exposes a `reboot_required` boolean —
  no reason. So when you open the overlay on a flagged server, the app reads
  Ubuntu's `/var/run/reboot-required` + `.pkgs` over SSH (read-only, reusing the
  health view's connection) and shows the pending packages — typically a
  **kernel/security update**. This is labeled as OS-level context, not as
  SpinupWP's internal logic (a fleet-wide check confirmed the boolean tracks that
  file 1:1).
- **Reboot is the big one** — its confirmation calls out that it takes the whole
  server down briefly (every site on it); a service restart is a brief blip.
- **A toast on completion.** A reboot can take minutes; when it (or a restart)
  finishes, a non-focus-stealing toast tells you (`example.com rebooted` /
  `Nginx restarted on example.com`), so you don't have to keep checking.

## Creating & connecting servers

Two write actions on the **Servers** tab that stand up a new server and make it
usable — both **need a Read/Write token**.

**Create a server (`c`).** Opens a form pre-filled to **match** the selected
server's provider, region, and size (or from scratch on an empty fleet). It prices
the build from the provider's catalog (DigitalOcean / Vultr / Linode / Hetzner),
suggests a hostname from your fleet's naming convention, and lets you switch
provider (`p`), region (`g`), or size (`e`) and toggle backups (`b`) before
confirming. Because the SpinupWP API can't list your configured server providers,
the first time you build on a provider the overlay asks for its SpinupWP provider
id (Account Settings → Server Providers) and saves it — once per provider. The
build fires `POST /servers` and tracks the ~10-minute provision in the background.

**Connect it with a vanity site (`V`).** A brand-new server has **no site**, so
there's nothing to attach an SSH key to and no way for Spinup to reach it — empty
servers are flagged in **amber** in the Servers list. Press `V` on one to build a
small placeholder ("vanity") site at the server's own hostname, end to end:

1. **DNS** — writes an `A` record for the hostname → the server IP (AWS Route 53),
   using the connection from the DNS module.
2. **Propagate** — waits for the record to resolve (so Let's Encrypt can issue);
   after ~2 minutes it offers to skip SSL for now or keep waiting.
3. **Site** — creates a blank site (`installation_method: "blank"`).
4. **HTTPS** — enables a free Let's Encrypt certificate.
5. **SSH key** — deep-links you to the site's **SFTP & SSH → Site User** to add
   your key (the API can't do this), then waits for you to confirm.
6. **Publish** — seeds a minimal, brand-neutral status page (it reads its own
   hostname, so it's reusable on any server). Press `o` to open the live site.

The whole build is a **resumable background job**: close the overlay and a header
badge keeps tracking it; press `V` on the server to reopen it (even after the site
exists). It survives quitting and relaunching the app. If a step fails, the overlay
shows where, with `r` to retry or `x` to discard.

## Privileged writes over SSH (sudo & SSH keys)

Some things the SpinupWP API simply can't do — it has **no** surface for SSH keys or
sudo users. Spinup does them directly over SSH instead, which means these actions use
**your own SSH access**, not the API token.

**Connect sudo (`S`).** Press `S` on a server and enter its SpinupWP **sudo user**
and that user's **sudo password** once. Spinup validates them against the live server
(`sudo -S -p '' true`) and then holds the password **in memory for the session only**
— the username persists to config, the password is never written to plaintext config.
A connected server shows a green `● sudo` badge on its row; `S` again disconnects.

- **Remember in the macOS Keychain (opt-in).** Tick the toggle when connecting and the
  password is saved to your **login Keychain** (service `spinup-sudo`, one item per
  server) — never to `config.json`, which only keeps the username and a `keychain`
  marker. Next time you press `S` on that server, sudo **auto-unlocks** with no
  retyping (the first read may show macOS's own "allow access" prompt — choose Always
  Allow). Press `f` to forget the saved password; disconnecting (`x`) a saved server
  offers a no-password **reconnect** rather than the credential form. Off macOS the
  toggle is absent and sudo stays in-memory per session.

**Grant / revoke an SSH key (`K`).** With sudo connected, press `K` on a site to write
keys into the site user's `authorized_keys`:

- **Pick which keys** — any of **your personal keys** (discovered from `~/.ssh/*.pub`
  and your ssh-agent, so you can SSH/SFTP as yourself) and/or Spinup's dedicated
  **`spinup-tui` machine key** (an ed25519 identity generated once into the config dir,
  deliberately **never added to your SpinupWP account** so SpinupWP's key reconciliation
  can't clobber it). Your selection is remembered.
- **Pick the scope** — just this site, or **every site on the server** in one pass
  (per-site progress, with a retry for any that fail).
- **Grant or remove** — `a`/`r` toggles the mode; removing pulls exactly the chosen
  key lines and leaves every other key (including SpinupWP-managed ones) untouched. The
  remote script is **idempotent** and a confirm overlay shows the exact command first.
- Site rows show what's granted at a glance — **👤** (your key) and/or **🔑** (the
  machine key).

## Cloning a server

Press **`C`** on a server to clone one or more of its sites onto a **new or existing**
destination server — a guided, two-pane wizard that lets you stage and verify a whole
migration and **only repoints DNS when you say so**. It needs a **Read/Write token**
(to create the destination sites) and **sudo connected on both ends** (the copy runs
over SSH). The steps:

1. **Plan** — pick which of the source's sites to clone (all selected by default;
   `space` toggles). Spinup sizes each one live (disk + database) into a payload total
   so you know what you're moving; a concurrency cap protects the busy source.
2. **Destination** — provision a fresh server pre-matched to the source (reusing the
   `c` flow), or `d` to pick an existing server as the target.
3. **Connect** — connect sudo on **both** servers. The clone is a server-to-server
   **pull**: the destination pulls each site directly from the source over SSH (no
   bytes routed through your laptop), authenticating with a key granted onto the source
   for the job and **revoked when it's done**.
4. **Clone sites** — a live roster runs the sites concurrently, each advancing
   `create → pull → config → verify → done`. Both stacks are handled: **Standard WP**
   (files + database, with `wp-config` re-stamped for the destination) and **Bedrock**
   (git-native — created from the repo, `composer install` over SSH, uploads + secrets
   pulled, `.env` re-stamped).
5. **Verify** — drill into any cloned site for a source-vs-clone comparison (wp-cli
   facts + an HTTP check that hits the **new** server while DNS still points at the old
   one).
6. **DNS cutover** — when you're satisfied, repoint **every** `A` record across each
   site's domains (apex + additional) to the new server, in one batched, partial-aware
   pass; `www`-style records that follow the apex are skipped, not clobbered. Records
   in zones you can't edit are listed for hand-editing.

The clone runs in the **background** — pressing `Esc` doesn't abandon it; a header
badge (`⠹ Cloning … — press C`) surfaces the in-flight job and `C` reopens the live
roster. Pairs naturally with the DNS module: **lower the TTLs** (`n`/`N` → `⏎`) a day
or two ahead so the cutover propagates fast.

## Local working copies

Bridge your SpinupWP sites to the local checkouts you actually edit. Press `L` on
a site (Servers / Stacks / Search) to link a path and the local URL where you
serve it; the site's details gain a "Local" field, and you can open the copy with
`t` (a terminal at the path) or `v` (its local URL). All of this is **local-only**
— no SpinupWP writes.

- **Auto-discover (`S`, Stacks tab).** Scan one or more folders and match their
  subdirectories to sites — by git remote, Bedrock `WP_HOME`, or folder name —
  then batch-link the matches.
- **"Needs a local copy" report (`f`, Stacks tab).** Lists the managed sites you
  have no usable local copy for (never linked, or a missing path), filterable by
  stack.
- **Markers & drift.** Linked sites show `◆` in the lists; a linked, on-disk copy
  shows its local git drift (`⇡N unpushed` / `● uncommitted`), read from the repo
  with no network.

Config keys: `localRoots` (folders to scan) and `localSites` (per-site path +
local URL — tool-agnostic: Valet, Cove, LocalWP, Herd, DDEV, …).

## Database backup & sync

For a WordPress site you've **linked** to a local copy, the Search tab can pull
the production database down — the same idea as a hand-rolled `wp db export` +
`scp`, without leaving the dashboard. Both actions are **read-only on production**
(they export; they never write to the live site) and run `ssh`/`scp`
non-interactively, so your key needs to be loaded in your agent.

- **Download a backup (`d`).** Exports the production database with `wp-cli` into
  a stage file *outside* the public webroot, gzips it, downloads it into the linked
  copy's `sql/` folder, and removes the remote copy. Needs **no local WP-CLI** —
  the export runs on the server. Available whenever a WordPress site is linked. A
  spinner on the site's row tracks an in-flight download even if you close the
  overlay; the saved path and size are shown on completion.
- **Pull production → local (`p`, opt-in).** A full refresh of your **local**
  database from production: it backs up the local DB first (to
  `sql/local_<timestamp>.sql.gz`), exports + downloads production, imports it
  locally, rewrites production URLs → your local URL (`wp search-replace`), and
  runs an optional `bin/sync.d/post-import.sh` hook if the project has one.
  **This overwrites your local database**, so it's **off by default** — enable it
  with `localSync` (see "Optional settings"). It needs a working local WP-CLI; if
  it's missing you get a clear error rather than a broken run.

Everything is detected automatically, for Standard WP **and** Bedrock:

- the **remote document root** from the API (`/sites/{domain}/files{public_folder}`),
- the **SSH target** from the site/server (`{site_user}@{server_ip}`),
- the **local WordPress root** from the linked path (where `wp` runs — wp-config
  for Standard WP, `wp-cli.yml` for Bedrock),
- the **local URL** for the rewrite from the link's local URL, falling back to the
  project's `.env` `WP_HOME`.

If your project already has a `bin/sync.d/post-import.sh` (e.g. Elementor URL
swaps, plugin toggles), it runs with `WEB_DIR`, `SYNC_REMOTE_HOST`, and
`SYNC_LOCAL_HOST` set — so existing per-project tweaks carry over with no extra
configuration. When a project has **no** hook yet, the `p` confirm screen
explains what the hook is and offers `s` to scaffold an **inert** sample
`bin/sync.d/post-import.sh` (every example commented out, documented with the env
vars above) for you to edit. Backups stay **gzipped** in `sql/`; decompress with
`gunzip` when you need one.

Both `d` and `p` show their progress as a **building checklist** inside the
overlay — each step gets a `✓` as it completes, the running step spins, and a
failure marks the exact step with `✕` — so you can see everything that happened,
ending with the saved paths. It keeps running if you close the overlay (`Esc`);
reopen with the same key to watch it through.

## Production media fallback

A `p` sync refreshes your local **database**, but not the media library — so the
local site shows broken images. Syncing the files is often impractical (some
libraries are hundreds of thousands of items). Instead, press **`m`** on a linked
WordPress site to serve any image that's **missing locally** straight from
production.

It works by dropping a small, self-contained mu-plugin into your local copy
(`wp-content/mu-plugins/` or Bedrock's `web/app/mu-plugins/`). The plugin rewrites
any uploads URL whose file isn't present locally to the production origin —
covering the standard media functions, page-builder output (e.g. Elementor inline
CSS and gallery data), and **legacy paths** left over from a Standard-WP →
Bedrock conversion. Because it decides "missing" from the real document root and
redirects to the **same path** on production, your production routing (CDN/S3
redirects included) resolves whatever it's handed.

- **It runs in WordPress, not your web server**, so it works the same on Valet,
  Herd, LocalWP, DDEV, MAMP — anything. No nginx/Apache config to get right.
- **Local-only and read-only on production** — it just hotlinks your own
  production images. It self-disables when running on the production domain, so
  it's inert if it ever gets deployed.
- **The plugin's presence is the on/off state** (no config flag). Press `m` to
  toggle; `u` from the overlay updates it in place when a newer version ships.
- Needs production reachable and hotlinking allowed (it won't work behind staging
  Basic-Auth). Images delivered by external CSS files or async JS/REST are the one
  thing server-side rewriting can't catch.

## DNS hosts, access & editing

A **server-migration lens** for DNS: see the records that move a site to another
server, and edit them in place. It is deliberately **not** a full zone editor — it
only ever shows and touches a site's own hosting records (its apex / `www` /
subdomains and additional domains), so your MX, TXT, DKIM, and other zone records are
never shown or changed. Moving a site can't take down its email.

- **The view.** Press `n` on a site for just that site's records, or `N` on a server
  for every site on it; inside a site-scoped view, `a` expands to the whole server.
  Each **site** is a line, labeled by its own domain (even when it's a subdomain),
  with its hosting record's type, **TTL in seconds**, value, a `◀ here` flag when the
  record points at this server, and a `+www` tag when `www` simply follows the apex.
  A site's additional domains nest beneath it, so a domain portfolio reads as one
  site, not many. TTLs come from the zone's authoritative nameserver (the configured
  value, not a counted-down one), so they show even for hosts you haven't connected;
  `r` refreshes.
- **Access (`✓ ↗ ○ ·`).** Each record's zone shows whether you can edit it: `✓`
  editable, `↗` web-only handoff, `○` the provider has an API but you haven't
  connected an account that holds the zone, `·` unknown. A zone is `✓` only when a
  connected account of the provider that actually serves it (its live nameservers)
  holds it — so a stale or duplicate zone elsewhere never shows a false green. With
  two or more accounts connected, an **ACCOUNT** column names the owning one.
- **Edit a TTL (`⏎`).** On an editable record, `⏎` opens a focused editor — pick a
  preset or a custom value, confirm, and it's written to **AWS Route 53** or
  **Cloudflare** through your connected account. This is the prep step for a low-risk
  migration: lower the TTL, cut over, then restore it. Before writing, an edit-time
  check re-reads the live nameservers and **blocks** the change if the connected
  account's zone isn't the one actually serving the domain. Route 53 changes are
  followed to completion; the record shows an "updating" status that keeps ticking
  even if you leave the view. Only the **TTL** is editable for now (repointing a
  record's target comes later), and Cloudflare **proxied** records are read-only.
- **Connect a provider (`c`).** Manage credentials for the selected zone's
  provider — **AWS Route 53** (an IAM access key), **Cloudflare** (a scoped token),
  or **GoDaddy** (a Production API key). Multiple accounts per provider are
  supported, with a drill-down into each account's zones. Credentials are verified
  before they're stored, kept in `config.json` (chmod 600), and the matching
  environment variables are honored (`CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`, `GODADDY_API_KEY` / `GODADDY_API_SECRET`). Secrets are
  masked as you type. Listing hosts needs only read access (Cloudflare `Zone:Read`);
  **editing a TTL** needs write access — Route 53 record writes, or a Cloudflare
  `Zone.DNS:Edit` token.
- **Web-only hosts (GoDaddy, Namecheap, Network Solutions, …).** A registrar with
  no usable API shows `↗`; press `w` (in the inventory or the connect overlay) to
  open its web console — for GoDaddy specifically, your Clients hub, with the
  domain copied to your clipboard so you can paste it after logging in as the
  client. Every `↗` zone also shows an **access note** — "Delegate Access" by
  default (the assumed-normal case for a client's registrar), or your own
  per-zone override (e.g. an IT vendor's contact) when that default doesn't hold.
  Press `c` on any such zone to open **Manage Access**: it lists every zone
  already known at that host, `n` edits the selected zone's note, and `r`
  resolves your whole fleet's DNS to fill in any zones it hasn't seen yet.

Provider credentials are optional — without them you still get the full host
inventory and TTLs, just without the editable/account columns or in-place editing.

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
    ubuntuEol.ts     Ubuntu LTS EOL dates (same embedded+refresh pattern as phpEol.ts)
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

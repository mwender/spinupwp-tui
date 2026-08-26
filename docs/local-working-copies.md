# Local working copies

Bridge your SpinupWP sites to the local checkouts you actually edit. Press `L` on
a site (Servers / Stacks / Search) to link a path and the local URL where you
serve it; the site's details gain a "Local" field, and you can open the copy with
`t` (a terminal at the path) or `v` (its local URL). All of this is **local-only**
— no SpinupWP writes.

- **Clone one from production (`L` → `c`).** For a site you have no copy of yet,
  `L` opens a choice: `e` to type in a path you already have, or `c` to build the
  copy from production. The clone pulls the code down — a `git clone` for
  git-deployed sites, an `rsync` over SSH for everything else — runs `composer
  install` if the checkout turns out to be Bedrock/Radicle, links it, and then
  hands off to the existing DB pull (`p`) and media fallback (`m`). It never
  touches your local database or webserver config.
  - **`wp-config.php` comes down too.** The pull takes the site's whole files
    root, so a `public/`-style layout brings the config from one level above the
    webroot — and the real webroot is *detected* on the server, never inferred
    from the `public_folder` setting. That config is **production's**, so point
    `DB_NAME` / `DB_USER` / `DB_PASSWORD` / `DB_HOST` at a local database before
    pulling the DB. (A Bedrock/Radicle clone has the opposite problem: `.env`
    isn't in the repo, so the checkout arrives without one.) The done screen
    says which applies.
  - **`wp-content/uploads` is skipped** — that's what the media fallback (`m`) is
    for — as are `object-cache.php` and `advanced-cache.php`, which are wired to
    production's Redis and fatal locally rather than degrading quietly.

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

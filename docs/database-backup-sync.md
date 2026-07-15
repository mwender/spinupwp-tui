# Database backup & sync

For a WordPress site you've **linked** to a local copy, the Servers or Search tab
can pull
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
  with `localSync` (see "Optional settings" in the README). It needs a working
  local WP-CLI; if it's missing you get a clear error rather than a broken run.

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

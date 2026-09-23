# Updating a site: PHP and WordPress core

Press `u` on a selected site (in the **Servers**, **Stacks** or **Search** tab) to open **Update**, which offers two choices: **PHP version** (`p`) and **WordPress core** (`w`). `←` from either one returns to the menu.

## WordPress core

The SpinupWP API can't update WordPress, so this runs wp-cli over SSH as the site user, in the site's detected WordPress directory. It uses the same key-based access as Plugins & themes (`e`) and doesn't need a Read/Write token.

- **Check first.** `wp core check-update` lists the versions you can move to. The cursor starts on the first minor (security or maintenance) release; a major release is marked so you know to test plugins and themes against it.
- **Update.** After you confirm with `y`, it runs `wp core update --version=<chosen>` and then `wp core update-db` (with `--network` on multisite), and reads the version back to verify it. If the update fails partway, the leftover `.maintenance` file is removed so the site doesn't stay on "Briefly unavailable". You can close the overlay while it runs; a toast reports the result.
- **Plugins and themes stay unloaded** (`--skip-plugins --skip-themes`). Core commands don't need them, and a plugin's PHP notices otherwise land in wp-cli's output and hide the update list. It also means a plugin that fatals can't block the core update that fixes it.
- **Bedrock and Radicle are allowed, with a warning.** Core there is installed by Composer, so the update patches `web/wp` on the server only. The confirm screen names the version `composer.lock` pins, because the next `composer install` (a git deploy, a clone) will reinstall that version. Run `composer update roots/wordpress` and commit the lock to keep the new version.

## WordPress core on a whole version group

In **Stacks**, press `u` on a version row (`└ WP 7.0.2`) to update every site in it. The hint bar shows `u update N sites` when a version row is selected.

- **Checks every site live first.** The version rows come from cached probes, which lag behind sites that update themselves, so each site is checked over SSH (6 at a time) before anything is planned. Each check also refreshes that site's cached version.
- **Plan.** The default target is the **newest release in each site's own line** (7.0.2 → 7.0.x). WordPress backports security fixes to older lines, so this is the low-risk hotfix. `m` switches to the **newest release overall**. Sites with nothing to do, sites whose check failed, and sites already mid-update are listed as skipped, each with the reason. `space` leaves a site out. Bedrock and Radicle sites are included and marked `⚙`, with the same `composer.lock` caveat as a single-site update.
- **Canary, always.** The first site in the plan updates alone. If it fails, no other site is touched. Standard WP sites sort first, so the canary is a plain install whenever the group has one.
- **Then the rest,** up to 4 at a time and never two on the same server. After 3 failures no new sites start. `x` stops starting new sites, and the ones already running finish.
- **Runs in the background.** Esc leaves it running. The rows show `⠧ → WP 7.1.2` while each site updates, and sites move into their new version row as they finish. A single toast reports the result, and `u` on a version row shows the progress or the summary. A failed site keeps `⬆!` on its row, and its error appears at the bottom of the summary when you select it.

## PHP version

A picker lists the available versions — the current one is marked,
end-of-life versions are flagged, and the list is sourced from the live PHP
release schedule (so new versions like 8.5 appear automatically). After you
confirm, the app calls `PUT /sites/{id}/php` and polls the resulting event until
it finishes.

- **Needs a Read/Write token.** SpinupWP exposes no token-scope endpoint, so a
  read-only token is detected when the upgrade comes back `403` — you'll get a
  clear "token is read-only" message and nothing changes. Swap in a Read/Write
  token (`spinuptui login`) to actually apply upgrades.
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

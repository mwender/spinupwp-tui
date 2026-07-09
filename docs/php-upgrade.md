# Upgrading PHP

Press `u` on a selected site (in the **Servers** or **Stacks** tab) to change its
PHP version. A picker lists the available versions — the current one is marked,
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

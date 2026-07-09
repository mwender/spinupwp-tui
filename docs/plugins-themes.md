# Installed plugins & themes

Press `p` on a site (Servers tab, sites pane) to list its installed plugins and
themes over SSH — the `wp plugin list` / `wp theme list` detail the SpinupWP API
never exposes (it only gives you *counts* of pending updates). You see every
plugin and theme with its **status** (active / inactive / must-use / dropin),
**current version**, and the **new version** when an update is available (`→ 1.2.3`
in gold; `✓ current` otherwise), grouped into `PLUGINS` and `THEMES` sections each
with an update badge.

It's strictly **read-only**: it runs wp-cli as the site user using your local SSH
keys (the same non-interactive auth the health view uses), and **detects the real
WordPress directory itself** rather than trusting the `public_folder` setting — so
it works on standard `/public/` installs and Bedrock (`web/wp`) alike, and even on
sites SpinupWP misclassifies as non-WordPress (it finds WordPress core over SSH).
Non-WordPress sites get a clear "no WordPress core found" message.

`↑↓` / `jk` scroll, `r` re-reads over SSH, `Esc` / `q` / `p` closes.

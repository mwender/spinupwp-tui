# Production media fallback

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

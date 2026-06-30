# Site-creation API findings (from building the clone-wizard test source)

Empirical findings from creating the clone-wizard **test source** on
`web1.spinuptui.com`: a Standard-WP site (`wp.spinuptui.com`) and a
Bedrock/git site (`bedrock.spinuptui.com`). These **correct several assumptions in
`docs/2026-06-24_clone-to-server-spec.md`** and feed two future features: the clone
wizard (item 5) and in-app Standard-WP/Bedrock site creation. Verified live against
`api.spinupwp.app/v1` on 2026-06-27.

## POST /sites — payload shape (corrects the spec)

The spec assumed a `git` block of `git[repo|branch|deploy_script|push_enabled]`.
**Wrong.** The real shape:

- **`deploy_script` is a TOP-LEVEL field on `POST /sites`, not inside `git`.** A
  nested `git.deploy_script` is silently ignored (came back `null`).
- The `git` object accepts: `repo`, `branch`, **`push_to_deploy`** (NOT
  `push_enabled`), **`always_run_deploy_script`**, `deploy_key_enabled`, and
  `deploy_key.{privatekey,publickey}`. The **response** normalizes these into
  `git.{repo,branch,deploy_script,push_enabled,deployment_url}` (so the read shape
  differs from the write shape — `push_to_deploy` in → `push_enabled` out).
- `installation_method` values used: **`wp`** (Standard WP) and **`git`** (Bedrock).
- `site_user` **must be ≥3 chars** (`wp` was rejected; used `wpsite`). Affects the
  spec's "reuse source site_user verbatim" decision — derive/pad if <3.
- `database{name,username,password,table_prefix}` is accepted on create (for both
  `wp` and `git`). `table_prefix` echoes back `null` but the DB is created. **The DB
  password is never returned by the API** → always *send* it so you know it (needed
  to write Bedrock `.env` / verify).
- `public_folder` is normalized with a trailing slash (`/web` → `/web/`).
- **No update endpoint exists** for git or the site in general — only
  `PUT /sites/{id}/php` and `POST /sites/{id}/git/deploy`. Everything (deploy_script,
  push_to_deploy, db, php, public_folder) must be correct **at create time**. A
  mistake = delete + recreate.

### `installation_method: "wp"` (Standard WP)
Fully server-side: SpinupWP installs WordPress from the `wordpress` block
(`title`, `admin_user`, `admin_email`, `admin_password`). **No SSH needed.** Result
site has `is_wordpress: true`, `public_folder: /`. This path is easy to offer in-app.

### `installation_method: "git"` (Bedrock)
Create **only clones the repo** — it does **not** install WordPress and does **not**
run the deploy script (see below). Result site is `is_wordpress: false` *even after
WordPress is installed* (SpinupWP's `is_wordpress` doesn't recognise the Bedrock
layout). → **The clone wizard must branch on `git.repo` presence, not
`is_wordpress`** (the spec already says this; this confirms why it matters).

## ⚠️ The big one: `git/deploy` does NOT run the deploy script

`POST /sites/{id}/git/deploy` performs only **`git pull` + checkout** — it does
**not** run the configured `deploy_script`. Verified three ways:
1. First deploy after create → output was just `Git pull / Checkout / Already on main`.
2. Deploy after a real new commit → same (no composer step).
3. **Deleted `vendor/` + `web/wp`, then deployed → they were NOT rebuilt.**

…all despite sending `git.always_run_deploy_script: true` at create (no API to read
it back; it evidently didn't take effect). So **a freshly-created Bedrock site is
never built by SpinupWP's API-triggered deploy** — `composer install` must be run
**ourselves over SSH**.

**Consequence for the clone wizard:** the Bedrock dest path canNOT rely on
`POST git/deploy` to `composer install`. After creating the `git` dest and seeding
`.env`/`auth.json`, the wizard must run `composer install` over the (sudo) SSH
connection it already holds — exactly what it does for the file/DB pull. The spec's
"re-trigger the deploy via `POST /sites/{id}/git/deploy` and that's the build that
must go green" is **wrong** for API-driven flows; replace with an SSH `composer
install`. (Open: whether the SpinupWP *dashboard* "Deploy" button or a real
push-to-deploy webhook runs the script — but the wizard is headless, so SSH is the
answer regardless.)

### Deploy-script flag bug (user convention)
The canonical deploy script `composer install --optimize-autoload --no-dev` uses a
**non-existent flag**: `composer install` has **`--optimize-autoloader` / `-o`**, not
`--optimize-autoload` (that exists only on `dump-autoload`). On the server's Composer
2.10 it errors with *"The --optimize-autoload option does not exist."* We built with
`composer install -o --no-dev`. Because SpinupWP never actually runs the stored
deploy script (above), this typo has been **silently harmless** — but the wizard /
any real deploy should use `-o`.

## Other findings

- **Deleting a site does NOT delete its database.** After `DELETE /sites/{id}` the
  `bedrock` DB + DB-user lingered, so recreating with the same `database.name`
  failed (`"bedrock already exists on this server"`). **Wizard impact:** a retried
  dest creation (after a failed attempt) can collide on the DB name — handle by
  reusing/cleaning the orphan or uniquifying the name.
- **Every site gets a temp subdomain** `*.apb.spinupwp.site` (HTTPS, reachable
  before real DNS). Handy for verification before cutover — though the wizard's
  `curl --resolve <domain>:443:<NEW_IP>` already covers this without DNS.
- **Server object carries the git deploy key.** `GET /servers/{id}` →
  `git_publickey` (per-server SSH key, `git@spinupwp`) and `ssh_publickey`. Add
  `git_publickey` to the Git provider repo as a **read-only deploy key** so SpinupWP
  can clone. (Account-level SSH keys are NOT auto-added to new site users — my
  personal key reached `web1` only because the vanity flow granted it; fresh sites
  need an explicit grant for SSH.)
- **Site layout on disk:** `/sites/{domain}/` with `files/` (deployed code; webroot =
  `files` + `public_folder`), `git/` (git working dir), `logs/`. Site user owns it;
  home is the site dir.

## Baseline plugins (always include when building for SpinupWP)

Every site Spinup builds should ship with **`limit-login-attempts-reloaded`** and
**`spinupwp`** active (user rule, 2026-06-27). Observed: `installation_method:"wp"`
already includes both (SpinupWP installs them — they were active on the fresh Standard
WP site with no action). **Bedrock/git does NOT** — add them explicitly: `composer
require wp-plugin/limit-login-attempts-reloaded wp-plugin/spinupwp` (committed, so they
deploy to a clone dest), then `wp plugin activate` over SSH. wp-cli-installed plugins on
Bedrock land in the gitignored `web/app/uploads`-sibling `web/app/plugins/` and would NOT
clone via git — so for Bedrock they must be composer-managed.

## Reusable patterns (future in-app site creation)

**Standard WP — trivial, all remote:** `POST /sites` `installation_method:"wp"` +
`wordpress{}` + `database{}`. Done. Offer this first.

**Bedrock — local-scaffold + remote-wire (6 steps):**
1. Scaffold locally: `composer create-project roots/bedrock <dir> --no-install`, then
   `composer update --no-install` to commit a lockfile. (Bedrock 1.31 bundles
   `wp-theme/twentytwentyfive` via `repo.wp-packages.org` — wpackagist's successor;
   theme namespace is `wp-theme/<slug>`, gitignored, composer-installed on deploy.)
2. `git push` the skeleton.
3. Add the server `git_publickey` as a **deploy key** on the repo (`gh repo
   deploy-key add`, read-only).
4. `POST /sites` `installation_method:"git"`, **top-level** `deploy_script`,
   `git{repo,branch,push_to_deploy,always_run_deploy_script}`, `database{}`,
   `public_folder:"/web"`.
5. **SSH (sudo): `composer install -o --no-dev`** in `files/` — because git/deploy
   won't (above).
6. **SSH: write `.env`** (the `database{}` creds we set + `WP_HOME=https://<domain>` +
   `WP_SITEURL=${WP_HOME}/wp` + fresh salts), then `wp core install` + `wp theme
   activate`. (`.env` is gitignored — we own it; it survives deploys.)

**Platform-agnostic local wiring (user's ask — future).** Steps 1–2 are
platform-neutral. Making the LOCAL copy *run* (local `.env`, local DB, served URL) is
the platform-aware part: model it as a **platform driver** (Valet / Herd / LocalWP /
DDEV / MAMP) behind one interface — `localUrl()`, `createLocalDb()`, `link()/serve()`
— so the generic flow (write local `.env` with local DB creds → create local DB →
`wp core install` locally → register with the platform) stays the same and only the
driver differs. The user runs Valet today (`~/webdev/laravel-valet/bedrock/<site>`),
so a Valet driver is the first; detect others by their CLIs/markers.

## Test source state (for the clone wizard)

`web1.spinuptui.com` (the test source) hosts:
- `wp.spinuptui.com` — Standard WP — **clone**
- `bedrock.spinuptui.com` — Bedrock, repo `mwender/bedrock-spinuptui` — **clone**
- `web1.spinuptui.com` — vanity placeholder — **do NOT clone**

Dest test server: `web2.spinuptui.com`. The server IDs / IPs and the dev sudo creds for
both ends live in the project `.env` (`SPINUP_DEV_CLONE_DEST`, `SPINUP_DEV_SUDO_SOURCE` =
web1, `SPINUP_DEV_SUDO_DEST` = web2). See `docs/clone-wizard-testing.md`.

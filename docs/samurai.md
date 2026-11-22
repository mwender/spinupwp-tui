# Samurai

Samurai applies the nginx fixes Sentinel's reports recommend, with your approval: blocking a scanner's probe paths, a crawler's user agent, or an URL space a bot keeps walking. Every rule is one of a few reviewed templates, shown to you before it's applied, checked by nginx before it goes live, and verified from outside afterwards.

A site is set up once (below), then each fix is reviewed and applied from its to-do.

## How it reaches the server

SpinupWP manages most of a site's nginx config itself and rewrites it on its own schedule, so Samurai never edits those files. It keeps all of a site's rules in one file of its own, `server/samurai.conf`, in the site's nginx config folder, and writes it through a small **gate**:

- **The gate is a root-owned script, `/usr/local/sbin/spinuptui-nginx`**, run by a dedicated `spinuptui-nginx` user through sudo, which may run that one command and nothing else.
- **Each site has its own allowlist** of files the gate may write, owned by root on the server. For Samurai that's `server/samurai.conf`, so SpinupWP's own files are never touched.
- **Each machine has its own deploy key per site**, and the server pins each key to its site, so a key can only act on that one site. A stolen key could rewrite that site's `samurai.conf`, and nothing else.
- **Every change is tested.** The gate runs `nginx -t` before reloading, and puts the previous files back if the test or the reload fails. It keeps the last 30 versions under `/var/backups/spinuptui/nginx/<site>/`.
- **SpinupTUI checks the gate before using it.** It installs only the gate it ships, and refuses to push through one whose version or contents differ.

## Setting a site up

Press **`F`** on a site (Servers tab or Search), or **`f`** on an nginx to-do whose site isn't set up yet. The same thing from a terminal:

```sh
spinuptui samurai setup example.com --plan     # changes nothing
spinuptui samurai setup example.com --apply
```

Setup shows every step first, and runs only when you confirm:

1. **Check the server.** The site's nginx config is where SpinupWP puts it, and whether nginx has the real-IP module (needed for the Cloudflare rule).
2. **Install the gate**, as root, through the server's sudo user. The screen lists every path this writes: the gate, its sudoers rule, its allowlists and keys under `/etc/spinuptui/nginx/`, and the `spinuptui-nginx` user.
3. **Make this machine's deploy key** for the site, in SpinupTUI's config folder.
4. **Register the site** with the gate: its allowlist and this machine's key. Keys other machines registered for the site are kept.
5. **Copy the site's nginx config here**, as a git repository in SpinupTUI's config folder. Certificates and private keys are never copied off the server.
6. **Prove it.** Push an empty `server/samurai.conf` (comments only) through the gate, which runs `nginx -t` and reloads, then check the site answers from outside as it did before.

**It needs sudo on the server.** Connect it first with `S` on the server in the Servers tab. For the command, tick "remember" so the password is saved in the macOS Keychain: setup feeds it to sudo over SSH, and it's never written anywhere else.

**Running it again is safe.** Once a site is set up, setup skips the root step, refreshes the local copy of the config and proves the path again, which is a quick way to check everything still works.

**Only the site's deploy key is ever offered to the gate's user.** Your other SSH keys and your SSH agent are never tried, so a server running fail2ban doesn't see a string of failed attempts.

## Applying a fix

In the Reports tab's to-do list, an nginx to-do with a fix shows **`f` apply fix**. Press it:

1. **Samurai proposes.** It refreshes its copy of the site's config, renders the rule from the fix's template, and shows you exactly what it would add to `server/samurai.conf`, and the checks it will make from outside afterwards. Nothing has changed yet. If every request the fix is meant to stop is already stopped, it says so and proposes nothing.
2. **`y` applies exactly that proposal.** The gate runs `nginx -t` before reloading, and puts the previous file back if the test fails.
3. **Samurai checks the site from outside**: each blocked path answers with the status the rule sets, and the home page answers as it did before. A check that fails is tried once more a few seconds later. If it still fails, Samurai puts the previous file back by itself and pages you through Beacon.
4. **The to-do is marked done**, with the proposal and the checks recorded on it.

**`u` on a fixed to-do rolls it back.** The rule comes out through the gate the same way, Samurai checks the home page still answers, and the to-do opens again.

From a terminal:

```sh
spinuptui samurai propose T-31          # prints the change, the checks, and the apply command
spinuptui samurai apply <proposal> --hash <hash>
spinuptui samurai rollback <proposal>
spinuptui samurai list
```

`apply` takes the proposal's hash, so what runs is exactly what you reviewed. It refuses if the site's `samurai.conf` changed since the proposal was made; propose again.

**`samurai.conf` is never edited in place.** Samurai rebuilds it from the fixes it has applied to the site, in order, every time. If someone changes it on the server some other way, Samurai notices and stops until it's put back.

**Every proposal is kept** in `~/SpinupTUI/samurai/proposals/`, applied or not, with what it changed and how its checks went. The local copy of each site's config is a git repository whose history holds every change and rollback.

## The templates

Samurai only ever writes one of these, and checks the parameters itself before rendering anything, whatever Sentinel proposed.

| Template | Writes | Checked from outside by |
|---|---|---|
| `deny-paths` | A `location` per path returning 403, 404 or 444 (`= /exact`, `^~ /prefix/`, or a limited pattern such as `~ ^/\.env`) | Each path answers that status (444: the connection is refused); the home page as before |
| `gone-paths` | The same, returning 410, for an URL space that should go away | Each path answers 410 |
| `block-user-agent` | A case-insensitive user-agent match returning 403 or 444 | A request with that user agent is refused; a browser still gets the home page |
| `cloudflare-real-ip` | `set_real_ip_from` for Cloudflare's published ranges (fetched and dated when proposed) and `real_ip_header CF-Connecting-IP` | The home page as before; the access log then shows visitors' own addresses |

**What Samurai refuses:**

- **Paths that would break the site.** It refuses any path rule that would also catch something a WordPress site needs: `/`, `/index.php`, `/wp-login.php`, `/wp-admin/`, `/wp-json/`, uploads, themes and plugins, `/wp-cron.php`, feeds, sitemaps, `robots.txt`, `xmlrpc.php`, ACME challenges, or ordinary pages.
- **User-agent rules that would block someone who should get in.** It refuses any rule that would also block Googlebot, Bingbot, Applebot and other search engines, social previews, Uptime Kuma, or an ordinary browser.
- **nginx syntax.** Parameters can't carry braces, quotes, semicolons or newlines, and patterns are limited to a safe subset.
- **Plain prefixes are made strict.** A plain prefix is written as `^~`, so a PHP file under it can't slip past to SpinupWP's PHP handler.

## What's on the server afterwards

| What | Where |
|---|---|
| The gate | `/usr/local/sbin/spinuptui-nginx` |
| Its sudoers rule | `/etc/sudoers.d/spinuptui-nginx` |
| Each site's allowlist and keys | `/etc/spinuptui/nginx/sites/<site>.allowed`, `.pub` |
| The deploy user | `spinuptui-nginx`, with one `authorized_keys` line per key, each pinned to its site |
| Backups of replaced files | `/var/backups/spinuptui/nginx/<site>/` |
| Samurai's rules | `/etc/nginx/sites-available/<site>/server/samurai.conf` |

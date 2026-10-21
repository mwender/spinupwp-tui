# Taking sites offline

When a server can't be patched yet against a critical vulnerability (say, a PHP remote-code-execution bug disclosed before your packages update), the advice is often to take the site offline until it can be. SpinupTUI does that a whole server at a time and remembers what it did, so bringing everything back is one step and never touches a site you'd disabled for some other reason.

## What "offline" means

It uses SpinupWP's own **disable site** setting. Checked on a test server:

- nginx drops the site's server block. Port 80 returns an empty reply and port 443 fails the TLS handshake (no certificate is served), for every domain on the site. The same happens when requests go straight to the server's IP with the site's hostname.
- So no request reaches PHP. That's stronger than a maintenance page, which PHP itself would render. Visitors see their browser's "can't connect" error.
- Files, the database and the certificate are untouched. The site's PHP-FPM pool keeps running (it only listens on a local socket) and its WP-cron entry stays in place.
- Disabling or re-enabling a site takes a few seconds. SpinupWP works through one server's sites one at a time, so a server with 20 sites takes a minute or two.

PHP is shared by every site on a server, so **the server is the unit**: a single site left enabled keeps the vulnerable PHP reachable. Disabling one site protects that site only.

## In the app

Press `a` on a server (Servers tab, or a result in Search) and choose **Take all N sites offline**. The confirmation lists the sites. Sites already disabled are left alone and aren't recorded. Progress is shown as each site goes down; you can press Esc and it carries on.

While any of a server's sites are offline, the server's row shows `⏻ off` (or `⏻ 3 off` when only some are), and the Overview's "Needs attention" panel lists it.

On a server SpinupTUI took offline, the same menu row becomes **Bring N sites back online**.

## From the command line

```sh
spinuptui offline                                   # what's offline right now
spinuptui offline web1.example.com web2.example.com # the plan; nothing changes
spinuptui offline web1.example.com --yes            # take every site on it offline
spinuptui online web1.example.com --yes             # bring back what that took down
spinuptui online --all --yes                        # bring back everything it took down
```

Servers are matched by exact name, IP address or SpinupWP id; a partial name is refused with suggestions, because this is not a command to aim loosely. `spinuptui offline --all` covers every server on the account. Without `--yes`, both commands print what they would do and change nothing. Add `--json` for one machine-readable result on stdout; progress always goes to stderr.

The exit code is `0` when everything succeeded and `1` when any site failed (each failure is listed). Re-running is safe: `offline` skips sites already down, and `online` retries only what's still recorded.

## What it remembers

Each site is recorded the moment SpinupWP accepts its disable, before it finishes, in `offline.json` in the account's data directory (next to `config.json` for the default account). If the run is interrupted, `online` still knows what to bring back. `online` re-enables only recorded sites:

- a recorded site someone already re-enabled is reported as already online;
- a recorded site that's since been deleted is reported and dropped;
- a site disabled some other way (in SpinupWP, say) is never touched. `spinuptui offline` marks those with `○`.

A failed re-enable stays recorded, so running `online` again finishes the job.

## Uptime Kuma

With Uptime Kuma connected, every monitor registered for the affected sites goes behind one manual maintenance window per server ("Offline: web1.example.com"), so taking 30 sites down doesn't page you 30 times. The window is removed once every site on that server is back. Kuma being unreachable never blocks the work; you'd just get the down alerts.

Monitors are matched by domain. If the same domain is also served from another server (a clone mid-migration), its monitors are paused too.

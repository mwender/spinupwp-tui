# Multiple SpinupWP accounts

If you look after sites in more than one SpinupWP account (your agency's own, plus a client who owns theirs), SpinupTUI can hold all of them and switch between them without restarting.

You always work in **one account at a time**. There is no merged fleet view, on purpose: with two clients' servers in one list, a reboot or DNS change meant for one could land on the other. The header shows which account you're in on every screen:

```
💡  Your fleet grouped by app type  ·  …        Account: Acme Agency  A switch
```

## The Accounts overlay (`A`)

Press `A` from any tab.

| Key | Action |
| --- | --- |
| `↑` `↓` / `j` `k` | Select an account |
| `⏎` | Switch to the selected account, or add one on **+ Add an account** |
| `e` | Rename the selected account (the name only lives on this machine) |
| `x` | Remove the selected account from this machine |
| `esc` | Close |

**Adding an account** takes three steps: a name for it, its API token (checked with SpinupWP before anything is saved, the same way first-run setup does), and its account slug, the part after `spinupwp.app/` in the dashboard URL, which `w` needs to open things in SpinupWP. The slug is pre-filled from the name, and you can leave it empty.

**Switching** reloads the whole app on the other account: servers, sites, events, probes and everything else are fetched fresh. If something that makes changes is still running (a PHP upgrade, an HTTPS or DNS change, a reboot, a key grant, a database backup or sync, a server build or clone, a WordPress update), the switch waits and the overlay names what's still going. Reads such as probes are simply dropped. The account you switch to is remembered for the next launch.

**Removing** an account forgets it on this machine: its token, DNS connections, local-copy links, its saved sudo passwords in the macOS Keychain, and its cached probes and DNS lookups. Nothing changes in SpinupWP, and files in your local working copies are left alone. You can't remove the account you're on, so switch away first.

## What each account keeps, and what's shared

| Per account | Shared by all accounts (this machine) |
| --- | --- |
| API token, base URL, account slug | Terminal app for local copies |
| SSH user override | Local scan roots (`S` discovery) |
| DNS provider connections (Cloudflare, AWS, GoDaddy) | Uptime Kuma login |
| Local working-copy links, local-sync opt-in | Last-seen version (release notes) |
| Sudo users and their Keychain passwords | |
| Granted-key records, preferred grant keys | |
| Server-provider ids, in-flight jobs | |
| Zone access notes, vanity health keys | |
| Uptime Kuma monitor mappings | |
| Cached app probes, DNS and zone lookups | |

The split follows one rule: SpinupWP numbers servers and sites per account, so two accounts can both have a server #42. Anything keyed by those ids has to belong to one account, and so do DNS credentials, since each client usually has their own. The Uptime Kuma *login* is shared because one agency's Kuma typically watches every account's sites, while which Kuma monitors belong to which site stays per account.

## Where it's stored

Everything stays in `~/.config/spinupwp-tui/config.json` (chmod 600), now shaped like this:

```json
{
  "terminalApp": "iTerm",
  "localRoots": ["~/webdev"],
  "uptimeKuma": { "url": "https://kuma.example.com", "username": "…", "password": "…" },
  "activeProfile": "default",
  "profiles": {
    "default": { "label": "Acme Agency", "token": "…", "accountSlug": "acme-agency", "localSites": {} },
    "client-co": { "label": "Client Co", "token": "…", "accountSlug": "client-co" }
  }
}
```

A config from before accounts existed is read as a single account with the id `default`, and rewritten in this shape the next time anything is saved. Its Keychain entries (`spinup-sudo` / `server-<id>`) and cache files (`stack-cache.json`, `dns-cache.json`, `providers-cache.json` in the config directory) keep their names, so upgrading moves nothing. Accounts added later namespace both: Keychain entries become `<account id>:server-<id>`, and caches go under `profiles/<account id>/`.

Downgrading to a version from before accounts will not find the token in the new shape, so it will run first-time setup again. Your other settings are untouched.

## Commands and environment variables

- `spinuptui where` prints the active account and lists the ids of the others.
- CLI commands (`ssh`, `ssh-exec`, `incidents`, `pull`) use the active account. `SPINUPTUI_ACCOUNT=<id>` picks a different one for a single run without changing the app's choice: `SPINUPTUI_ACCOUNT=client-co spinuptui ssh example.com`.
- `SPINUPWP_ACCESS_TOKEN` in the environment (or a `.env` in the launch directory) overrides the stored token and so pins the account. While it's set, the overlay explains that switching is disabled instead of silently changing nothing. `SPINUPWP_ACCOUNT_SLUG` likewise only applies to that token's account, or to the `default` account.

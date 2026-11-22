# Samurai

Samurai applies the nginx fixes Sentinel's reports recommend, with your approval: blocking a scanner's probe paths, a crawler's user agent, or an URL space a bot keeps walking. Every rule is one of a few reviewed templates, shown to you before it's applied, checked by nginx before it goes live, and verified from outside afterwards.

This page covers setting a site up for Samurai. Applying fixes from the Reports tab builds on it.

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

## What's on the server afterwards

| What | Where |
|---|---|
| The gate | `/usr/local/sbin/spinuptui-nginx` |
| Its sudoers rule | `/etc/sudoers.d/spinuptui-nginx` |
| Each site's allowlist and keys | `/etc/spinuptui/nginx/sites/<site>.allowed`, `.pub` |
| The deploy user | `spinuptui-nginx`, with one `authorized_keys` line per key, each pinned to its site |
| Backups of replaced files | `/var/backups/spinuptui/nginx/<site>/` |
| Samurai's rules | `/etc/nginx/sites-available/<site>/server/samurai.conf` |

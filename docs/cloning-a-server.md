# Cloning a server

Press **`C`** on a server to clone one or more of its sites onto a **new or existing**
destination server — a guided, two-pane wizard that lets you stage and verify a whole
migration and **only repoints DNS when you say so**. It needs a **Read/Write token**
(to create the destination sites) and **sudo connected on both ends** (the copy runs
over SSH). The steps:

1. **Plan** — pick which of the source's sites to clone (all selected by default;
   `space` toggles). SpinupTUI sizes each one live (disk + database) into a payload total
   so you know what you're moving; a concurrency cap protects the busy source.
2. **Destination** — provision a fresh server pre-matched to the source (reusing the
   `c` flow), or `d` to pick an existing server as the target — each listed with its
   current site count, so you can see at a glance how busy a candidate already is.
3. **Connect** — connect sudo on **both** servers. The clone is a server-to-server
   **pull**: the destination pulls each site directly from the source over SSH (no
   bytes routed through your laptop), authenticating with a key granted onto the source
   for the job and **revoked when it's done**.
4. **Git access** (only when a Bedrock site is selected) — each repo gets its **own
   read-only deploy key**, generated locally and never persisted: the public half
   goes on the repo (added for you via `gh` when it's installed and authed, or shown
   for a manual add — `o` opens the repo's deploy-key settings, `y` copies the key),
   and the pair rides the site create so SpinupWP installs it as the new site's git
   identity. Per-site keys are what let any number of Bedrock repos land on one
   server — GitHub allows a deploy key on only **one** repository account-wide, so a
   shared server key stops working at the second repo.
5. **Clone sites** — a live roster runs the sites concurrently, each advancing
   `create → pull → config → verify → done` with **live transfer progress** (bytes,
   rate, elapsed; database pulls show a true percent). Three stacks are handled:
   **Standard WP** (files + database, with `wp-config` re-stamped for the
   destination), **Bedrock** (git-native — created from the repo, `composer install`
   over SSH, uploads + secrets pulled, `.env` re-stamped), and **files-only** for
   non-WordPress sites (redirect shells, static/PHP — opt-in in Plan, no database).
   The pull **detects each site's real webroot** rather than trusting settings —
   `public/`-style layouts (with `wp-config.php` one level above the webroot) are
   preserved, and mid-move layouts are normalized on the destination. **Additional
   domains carry over** automatically (with their redirect settings), so the clone
   answers for every hostname the source did.
6. **Verify** — drill into any cloned site for a source-vs-clone comparison (wp-cli
   facts + an HTTP check that hits the **new** server while DNS still points at the old
   one; files-only sites compare file count, size, and HTTP instead).
7. **DNS cutover** — the wizard **waits for your explicit go** (`c`) after the roster
   settles, then repoints `A` records across each site's domains (apex + additional)
   to the new server in one batched, partial-aware pass; `↑↓`/`space` include or
   exclude individual records first. `www`-style records that follow the apex are
   skipped, not clobbered. Cloudflare **proxied** records repoint automatically too
   (their origin IP is always PATCHable even though their TTL stays fixed to
   automatic). Records in zones you can't edit show your DNS access note and `⏎`
   opens that zone's registrar console with the zone name copied — ready to paste.

The clone runs in the **background** — pressing `Esc` doesn't abandon it; a header
badge (`⠹ Cloning … — press C`) surfaces the in-flight job and `C` reopens the live
roster. `←` (or `h`) steps **back a screen**: the setup steps go back freely, and
once cloning has started the one back edge is DNS cutover → the clone roster — so
you can re-verify or retry a site before flipping live traffic. **Every job writes a full log** (`~/.config/spinupwp-tui/logs/`, passwords
redacted, self-pruning) — `⏎` on a failed site shows the complete error and `r`
retries just that site. Pairs naturally with the DNS module: **lower the TTLs**
(`n`/`N` → `⏎`) a day or two ahead so the cutover propagates fast.

For the under-the-hood design (why it's structured this way, what's safe/reversible
at each step), see [docs/clone-wizard-explained.md](clone-wizard-explained.md).

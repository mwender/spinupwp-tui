# Cloning a server

Press **`C`** on a server to clone one or more of its sites onto a **new or existing**
destination server — a guided, two-pane wizard that lets you stage and verify a whole
migration and **only repoints DNS when you say so**. It needs a **Read/Write token**
(to create the destination sites) and **sudo connected on both ends** (the copy runs
over SSH). The steps:

1. **Plan** — pick which of the source's sites to clone (all selected by default;
   `space` toggles; `a` toggles all; `PgUp`/`PgDn` or `[`/`]` pages long
   lists). SpinupTUI sizes each one live (disk + database) into a payload total
   so you know what you're moving; a concurrency cap protects the busy source.
2. **Destination** — provision a fresh server pre-matched to the source (reusing the
   `c` flow), or `d` to pick an existing server as the target — each listed with its
   current site count, so you can see at a glance how busy a candidate already is.
3. **Connect** — connect sudo on **both** servers. The clone is a server-to-server
   **pull**: the destination pulls each site directly from the source over SSH (no
   bytes routed through your laptop), authenticating with a key granted onto the source
   for the job and **revoked when it's done**.
4. **Git access** — by default, a Bedrock clone uses the destination server's
   server-wide SSH key, for accounts that authorize that key on GitHub. Press `g`
   on Plan to use the stricter **per-repo deploy-key** workflow instead; that
   generates a unique read-only key for each repository and walks you through adding
   it via `gh` or manually. The selected mode is remembered.
5. **Clone sites** — a live roster runs the sites concurrently, each advancing
   `create → pull → config → verify → done` with **live transfer progress** (bytes,
   rate, elapsed; database pulls show a true percent). Three stacks are handled:
   **Standard WP** (files + database, with `wp-config` re-stamped for the
   destination), **Bedrock** (git-native — created from the repo, `composer install`
   over SSH, project + site-scoped Composer credentials and secrets pulled, `.env`
   re-stamped), and **files-only** for
   non-WordPress sites (redirect shells, static/PHP — opt-in in Plan, no database).
   The pull **detects each site's real webroot** rather than trusting settings —
   `public/`-style layouts (with `wp-config.php` one level above the webroot) are
   preserved, and mid-move layouts are normalized on the destination. **Additional
   domains carry over** automatically (with their redirect settings), so the clone
   answers for every hostname the source did.
6. **Verify** — drill into any cloned site for a source-vs-clone comparison (wp-cli
   facts + an HTTP check that hits the **new** server while DNS still points at the old
   one; files-only sites compare file count, size, and HTTP instead).
7. **HTTPS handoff** — HTTPS sites carry their active certificate into SpinupWP as a
   temporary custom certificate, so the destination serves the same trusted TLS before
   DNS moves. Certificate bodies and keys are never written to the clone log or job.
   After cutover, Let’s Encrypt sites are switched back to SpinupWP-managed renewal;
   custom source certificates remain custom.
8. **DNS cutover** — the wizard **waits for your explicit go** (`c`) after the roster
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
retries just that site. A TLS-only failure can be retried with `T` without copying
files or the database again. Pairs naturally with the DNS module: **lower the TTLs**
(`n`/`N` → `⏎`) a day or two ahead so the cutover propagates fast.

For the under-the-hood design (why it's structured this way, what's safe/reversible
at each step), see [docs/clone-wizard-explained.md](clone-wizard-explained.md).

## Repairing an interrupted clone

When the selected destination already contains the same domain, Clone adopts that
site instead of trying to create a duplicate. It resets the destination database
credential, restores the source configuration, then resumes the dependency build,
uploads, and database import. This makes a failed or interrupted clone resumable
without deleting the destination site. The destination DB credential changes during
this repair; source files and database remain read-only.

For sites cloned before HTTPS handoff existed, run **Finalize move** and press `T`
at the Cutover step to stage their certificates before moving traffic.

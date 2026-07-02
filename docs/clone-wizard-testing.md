# Clone wizard — testing & ops reference

A living reference for driving and re-testing the **server-clone wizard** (`C`) against
the dedicated test boxes. Not a dated handoff — keep this current as the wizard evolves.

Concrete coordinates (server IDs / IPs) live in `docs/2026-06-27_site-creation-api-findings.md`
and your gitignored `.env`; **no credentials or sudo usernames belong in this file.**

Full spec: `docs/2026-06-24_clone-to-server-spec.md`. API contract:
`docs/2026-06-27_site-creation-api-findings.md`.

## Status

The clone wizard is **feature-complete and validated live end to end** — Plan →
Destination → Connect → Clone (Standard WP **and** git-native Bedrock) → Verify → DNS
cutover, plus background/reopen. The full migration arc (clone both test sites → verify
→ live DNS flip) has been watched working in the app multiple times. Shipped in v0.9.0.

Key files: `src/lib/serverClone.ts` (`sudoExec`, `estimateSourceSiteSizes`,
`runStandardWpPull`, `runBedrockPull`, `verifyClone`), `src/ui/views/CloneWizard.tsx`,
the `cloneJob` slice in `src/ui/store.tsx`, `src/lib/dnsRecords.ts` (cutover write).

## Test infrastructure (dedicated test boxes — NOT production)

- **Source = `web1.spinuptui.com`.** Its sites:
  - `wp.spinuptui.com` — Standard WP — **clone**
  - `bedrock.spinuptui.com` — Bedrock (repo `mwender/bedrock-spinuptui`) — **clone**
  - `web1.spinuptui.com` — vanity placeholder — **do NOT clone**
- **Dest = `web2.spinuptui.com`.**
- Server IDs / IPs / the dest sudo user: see the API-findings doc and your `.env`.
- **`.env`** (gitignored) carries the dev shortcuts and creds:
  - `SPINUP_DEV_CLONE_DEST` — the dest server id (pre-points the Destination picker).
  - `SPINUP_DEV_SUDO_SOURCE` / `SPINUP_DEV_SUDO_DEST` — `user:password` for each end;
    when set, the wizard auto-connects sudo on both ends (password-free). The real flow
    never reads these.
  - Token comes from `~/.config/spinupwp-tui/config.json` (R/W).

## Re-running the migration arc (the recipe)

Drive it in a **real terminal** (or pilotty) — there are 24+ servers and `C` acts on the
highlighted row, so scripted navigation mis-targets.

1. `bun run dev` **from the repo** (so `.env` loads) — not the global `spinup`.
2. `2` → Servers. Highlight **`web1.spinuptui.com`** (the test source).
3. **(Optional TTL prep)** `N` → drop the apex/www TTLs on the two test sites a bit ahead
   so the cutover propagates fast (per-record `⏎ edit TTL`).
4. `C` → clone wizard (Plan). `wp` + `bedrock` are selected; **`space`** to deselect the
   `web1.spinuptui.com` vanity row. Wait for the per-site sizes + total. `⏎`.
5. **Destination** — `d` to pick the existing dest (web2). → Connect.
6. **Connect** — the dev auto-sudo connects both ends (no passwords). Wait for both
   `✓ connected`, then `⏎`.
7. **Clone sites** — the roster runs both: `wp.spinuptui.com` (Standard WP) and
   `bedrock.spinuptui.com` (git-native Bedrock), each advancing
   `create → pull → config → verify → ✓ done`.
8. **Verify** — drill into each: source-vs-clone wp-cli diff + a `--resolve` HTTP 200
   against the dest while DNS still points at the source.
9. **DNS cutover** — repoint each site's A records to the **dest** server, confirm in the
   host, and `dig`/`curl` once propagated.

**Watch for:** background/reopen works (`esc` backgrounds the job; header badge; `C`
reopens) — but let a clone finish before cutover. To re-run from scratch: **delete the
dest sites on web2 and re-point DNS back to web1** (the driver won't adopt a pre-existing
dest site — it errors on create).

## What's proven

The whole arc, live in the app (multiple runs): Standard-WP clone, Bedrock pull, verify
drill-down, DNS cutover, background/reopen. `runStandardWpPull` is also independently
proven (HTTP 200, clean source-key revoke); `blank`+`database` create; Plan sizing.

## Hard-won lessons baked into the code (don't relearn)

- **The webroot is DETECTED, never assumed.** The 2026-07-02 web2→mercury production
  run failed all 6 sites because every long-lived Standard-WP site there uses
  `/public/` while both test sites use `/`. And the `public_folder` *setting* can't be
  trusted either: SpinupWP never moves files (the panel warns you to do it yourself —
  the user's SOP), so setting and reality can disagree. The Standard-WP pull now runs
  a `detect` stage on the source (`detectWpDirScript` — wp-settings.php is the core
  marker), `planWebroot` decides the action (match → as-is; core at files root +
  deeper setting → **normalize the dest**: sweep files under the configured folder
  with **wp-config.php placed one level ABOVE the webroot** (the config-above-webroot
  convention — a deliberate product stance, see CLAUDE.md "WordPress layout rules"),
  completing the move-the-files step; subdirectory install → as-is; two custom dirs →
  clear refusal),
  and verify/sizing use the same detection. Local matrix test:
  `layout-test.ts` pattern (fake trees + the exact bash fragments). Bedrock keeps
  running wp-cli from the project root. Any new test coverage should include a
  `/public/` site — `pub.spinuptui.com` on web1 was created for exactly this (WP at
  files root + `/public/` setting = the mid-SOP state; a correct clone comes out
  *healed* and serving).
- **`is_wordpress: false` non-git sites clone as FILES-ONLY** (stack `"files"`:
  redirect shells, static/PHP sites — no DB, no wp-cli). Opt-in in Plan (default
  deselected, tagged "files only"); dest is created blank with NO database block;
  `runFilesOnlyPull` reuses the hardened tar transport (per-site key, tolerant
  tar, 60-min budget, byte meter) minus all WP stages; `verifyFilesClone` compares
  file count + total bytes (1% tolerance) + HTTP. Validated live web1→web2 with
  `static.spinuptui.com` (fixture left in place; PHP executes on the clone).
  Additional-domain carry-over applies as usual — that's the main event for
  redirect shells.
- **Dest DB `table_prefix` must match the source** (production uses `wzl_`, `s81_`,
  etc.) — the create payload now copies `database.table_prefix`.
- **Additional domains must be re-created on the dest** — a fresh site's nginx
  `server_name` holds ONLY the primary domain (verified on the test boxes), so
  `www.` + extra hostnames would 404/default-vhost after cutover.
  `syncAdditionalDomains` (`src/lib/cloneDomains.ts`) copies the source's set —
  redirect settings included — right after the dest create; idempotent (skips
  domains already present), so per-site retries are safe. Proof of success =
  the dest's nginx `server_name` line; a `www` request answering 301 (WordPress
  canonical redirect) means it's working.
- **`DELETE /sites/{id}` orphans the SpinupWP database RECORD unless you pass
  `delete_database=true`** (also `delete_backups=true`). An orphaned record —
  even with the actual MySQL DB dropped by hand — makes any later create that
  reuses the db name fail with a 422 ("already exists on this server"), and
  orphaned records can only be removed in the SpinupWP web UI. When deleting
  clone leftovers, always delete the database with the site. (web2 currently
  has an orphaned `pubsite` DB record from learning this; the live fixture
  clone uses `pubsite2`.)
- **Every clone job writes a JSONL log** to `<configDir>/logs/clone-<ts>-<src>-to-<dst>.jsonl`
  (every sudo script + full stdout/stderr, passwords redacted). The roster truncates
  errors; `⏎` on a failed site shows the full error + the log path. Read the log
  before re-driving anything.

- **The pull key must be PER SITE** (`/root/.clone_pull_<domain>` + per-domain
  authorized_keys marker). A single shared key file + concurrency 3 meant each
  site's auth stage regenerated it and each revoke deleted it — breaking every
  other in-flight site's SSH mid-chain (proven live 2026-07-02: a db pull got
  "Permission denied (publickey)" seconds after another site's auth replaced the
  key; only ever ONE site per run survived, whichever ran unopposed).
- **Remote tar exit 1 is a WARNING, not a failure.** Live sites change files
  mid-read (every-minute WP cron + bot traffic; one growing log file suffices) →
  GNU tar exits 1, and `--warning=no-file-changed` suppressed the message but NOT
  the exit code — silent fatal "file pull failed". The files stage now tolerates
  rc ≤ 1 and keeps tar's warnings unsuppressed so the clone log names the exact
  file; ≥2 / 124 (timeout) / 255 (ssh) still fail hard.
- **rsync-over-ssh HANGS** in the sudo transport → files use **tar-over-ssh**, the DB uses
  **cat-over-ssh**, each bounded with `timeout -k 5 N`.
- Order is **files → re-stamp wp-config → db import** (import needs wp-config already
  pointing at the dest DB).
- **Revoke with `sed /marker/d`, never `grep -v`** (grep exits 1 when it removes the only
  line → would leave the key behind; source site users often have no other keys).
- `POST /sites/{id}/git/deploy` does **not** run the deploy script (only git pull) →
  Bedrock build uses SSH `composer install -o --no-dev`, not the API deploy.
- `deploy_script` is **top-level** on `POST /sites`; git uses `push_to_deploy` /
  `always_run_deploy_script`. No site/git update endpoint. Deleting a site **orphans its
  DB**. `site_user` ≥ 3 chars. (All in the API-findings doc.)

## Resuming headless dev/testing

Scratchpad harnesses auto-purge with the session; the patterns are simple to recreate:
a `sudo_run.py` = `ssh <sudouser>@<ip> "sudo -S -p '' bash -s"` piping `password\n<script>`
(reads creds from `.env`); the `.ts` harnesses import from `src/lib/serverClone.ts` and
drive it with the `.env` creds. Prefer **pilotty** for TTY-less UI runs (see CLAUDE.md).
`bun run typecheck` must stay green.

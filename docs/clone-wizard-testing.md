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

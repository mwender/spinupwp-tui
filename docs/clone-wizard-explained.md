# How the clone wizard actually works

A look under the hood at what happens when you press **`C`** on a server. Written for
fellow devs — this is the source for the "how it works" page on spinuptui.com; the
step-by-step re-run recipe for testing lives separately in `docs/clone-wizard-testing.md`.

## The short version

There's no clone/duplicate endpoint in the SpinupWP API, so this isn't one API call —
it's an orchestration across three things: **SpinupWP API writes** (create the
destination server + sites), **SSH run server-to-server** (the actual file/database
copy and verification), and **DNS provider writes** (the cutover, at the very end and
only when you say so). Spinup sequences and gates all three.

The source server is **never modified**. Every step up through Verify only *reads* from
it (file reads, a `wp db export`, one short-lived SSH key). The only writes anywhere
before you approve the DNS cutover are to the **new** server and its **new** sites —
nobody's traffic is pointed at them yet, so there's nothing to break. That's the whole
safety model: everything is additive and reversible until the one deliberate DNS flip.

## The seven steps

**1. Plan.** Pick which of the source server's sites to bring (all selected by
default). Spinup sizes each one live — webroot bytes via `du -sb` plus the database
size via `wp db size`, in one SSH round trip per server — so you see a payload total
before committing to anything.

**2. Destination.** Provision a fresh server pre-matched to the source's provider/
region/size (reusing the standalone "create a server" flow), or point at an existing
one. This is the first real write, and the first hard confirm (it costs money).

**3. Connect.** Sudo is connected on **both** ends. This isn't optional plumbing — the
whole copy runs as a **pull**: the destination authenticates *into* the source and
initiates every read. Nothing is relayed through your laptop; bytes move
datacenter-to-datacenter.

**4. Gitaccess** *(Bedrock sites only)*. If a selected site deploys from git, the
destination server's own deploy key needs read access to that repo before SpinupWP can
clone it at site-creation time. Spinup checks and, if needed, walks you through adding
it.

**5. Clone.** The fan-out — every selected site runs an independent chain, several at
once (capped at a concurrency limit so the *source* isn't hammered while it's still
serving live traffic). See "The per-site chain" below for what actually happens here.

**6. Verify.** Per site, a read-only source-vs-clone comparison: WordPress core
version, post/page/user counts, active plugin count, `siteurl`/`home` — plus an HTTP
request to the **new** server's IP via `curl --resolve`, so you get a real response
code from the clone while DNS still points at the old box.

**7. DNS cutover.** Only once you're satisfied. One batched pass repoints every `A`
record across every cloned site's domains (apex + additional domains) from the old
server's IP to the new one. `www`-style records that simply follow the apex aren't
touched — only the records that actually need to move. Records in a zone Spinup can't
write to are called out for you to change by hand. This is the one moment that affects
live traffic, and it's gated behind its own explicit confirmation.

## The per-site chain (step 5, in detail)

Each site's clone is its own state machine: `create → pull → done` (or `error`, with a
per-site retry that doesn't block the rest of the fleet). "Pull" itself has several
sub-stages, and they run in a specific order for a reason:

| Stage | What happens | Applies to |
|---|---|---|
| **create** | `POST /sites` on the destination — `blank` for Standard WP (files pulled in later), `git` for Bedrock (SpinupWP clones the repo using the destination server's deploy key). Same domain as the source, since DNS hasn't moved yet. | both |
| **auth** | An ephemeral SSH keypair is generated on the destination and its public half is appended to the source site user's `authorized_keys`, marked with a unique comment so it can be found and removed later. | both |
| **build** *(Bedrock only)* | SpinupWP's git deploy clones the repo but never runs the deploy script, so a fresh Bedrock destination has no `vendor/` or `web/wp`. Spinup pulls `auth.json` (needed for private Composer repos) and runs `composer install -o --no-dev` itself, over the SSH connection from step 3. | Bedrock |
| **files** | Standard WP: a `tar`-over-SSH stream of the whole webroot (excluding caches), pulled and extracted on the destination. Bedrock: just the gitignored `web/app/uploads/` directory, since the code already arrived via the git deploy. **`rsync` is not used** — it was found to hang over this transport; `tar` piped through SSH doesn't. | both |
| **config** | Standard WP: `wp config set` re-stamps `DB_NAME`/`DB_USER`/`DB_PASSWORD` in `wp-config.php` to the destination's own generated credentials. Bedrock: the source's `.env` is pulled verbatim and its `DB_*` values (and any `DATABASE_URL`) are swapped to the destination's — everything else (salts, `WP_HOME`, custom app vars) survives untouched. This runs **before** the database import, deliberately — the import needs the site already pointing at its own database. | both |
| **db** | On the source: `wp db export` to a file (never straight to stdout — plugin output on stdout has corrupted dumps before), gzipped. On the destination: pulled over the same SSH hop and `wp db import`ed. | both |
| **verify** | `wp core is-installed` on the destination, as a fast sanity check before the fuller source-vs-clone comparison in step 6. | both |
| **revoke** | Always runs, even on failure: the ephemeral key is stripped from the source's `authorized_keys` by its comment marker (not a full-key match, which is brittle through shell quoting), and every temp file on the destination is removed. | both |

## Decisions worth knowing about

- **Pull, not push.** The destination — a throwaway box you can discard if something
  goes wrong — initiates every read against the source. The source only ever answers
  requests from a key it was explicitly, temporarily granted.
- **`tar` over `rsync`.** Confirmed live: `rsync`-over-SSH hangs in this transport.
  `tar` streamed through `cat`/`ssh` doesn't, so that's what both the files and the
  database dump use.
- **Files, then config, then database — in that order.** Importing the database before
  the site's config points at the destination's own database would either fail or
  silently write into the wrong one.
- **A Bedrock site's first deploy is expected to fail, and that's normal.** SpinupWP's
  `git`-installation-method create only clones the repo; it doesn't run the deploy
  script or install Composer dependencies. Spinup runs `composer install` itself once
  the gitignored `auth.json` has been pulled across — that's the build that actually
  has to succeed.
- **Concurrency is capped to protect the source, not the destination.** Cloning several
  sites in parallel is bounded (default: a handful at once) because the limiting factor
  is disk I/O on the **source** server, which is still serving real production traffic
  throughout the whole process.
- **The cutover is partial-aware on purpose.** If some of a fleet's DNS zones aren't
  editable (an unconnected provider, a registrar with no API), Spinup still flips
  everything it *can* write to in one pass and gives you an exact list for the rest —
  instead of blocking the whole cutover on the one zone it can't reach.

## Safety envelope, summarized

- Two hard confirms gate the only actions that cost money or move live traffic:
  **provisioning the destination server**, and **the DNS cutover**.
- Everything between those two confirms only creates new, unreferenced resources — a
  server and sites nobody's traffic points at yet. Abandoning the wizard at any point
  before cutover leaves the source completely untouched.
- The one thing ever written to the source is a short-lived SSH key, scoped to a single
  site user, always revoked at the end of that site's clone — including on failure.

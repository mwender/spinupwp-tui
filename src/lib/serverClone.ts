// Orchestrator for "clone a server to a new server" (backlog item 5). Built on the
// sudo-over-SSH transport (mirrors ssh.ts runSudoSiteOp): SSH to the server's sudo
// user with your key, then `sudo -S` reads the password from stdin so nothing is
// injected or persisted. The privileged password is passed in by the caller (the
// store holds it in memory; a headless harness reads a dev one) — never stored here.
//
// SLICE 4a (this file): the transport + source-read sizing for the Plan step. The
// per-site pull chain (create → pull → config → deploy → verify) lands next; it
// extends this same transport. See docs/2026-06-24_clone-to-server-spec.md and
// docs/2026-06-27_site-creation-api-findings.md (the create-only/git-deploy findings
// that shape the Bedrock branch).

import type { Server } from "../api/types.ts"
import { wpCliResolveScript } from "./wpCli.ts"

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"]

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function sqlq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function sqlIdentifier(s: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error("Destination database name contains unsupported characters.")
  return s
}

// An adopted destination was created by an earlier interrupted Spinup clone, so
// the original generated DB password is intentionally unavailable after restart.
// Reset every matching MySQL account to this run's fresh password before writing
// its .env/wp-config. The database itself is never dropped or recreated.
export function repairDestinationDatabaseScript(dbName: string, dbUser: string, password: string): string {
  const user = sqlq(dbUser)
  const pass = sqlq(password)
  const database = sqlIdentifier(dbName)
  const lookup = shq(`SELECT Host FROM mysql.user WHERE User = ${user};`)
  return [
    `HOSTS=$(mysql --defaults-file=/home/spinupwp/.my.cnf -NBe ${lookup})`,
    `[ -n "$HOSTS" ] || { echo "No destination MySQL user found for ${dbUser}." >&2; exit 65; }`,
    `while IFS= read -r HOST; do mysql --defaults-file=/home/spinupwp/.my.cnf -e "ALTER USER ${user}@'$HOST' IDENTIFIED BY ${pass}; GRANT ALL PRIVILEGES ON ${database}.* TO ${user}@'$HOST';"; done <<< "$HOSTS"`,
    `mysql --defaults-file=/home/spinupwp/.my.cnf -e "FLUSH PRIVILEGES;"`,
  ].join("; ")
}

export interface SudoResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

// Run a bash script as root on `server` via its sudo user. `script` is fed on stdin
// after the password line, so `sudo -S -p ''` consumes the password and bash reads
// the rest. Key-based SSH to the sudo user is assumed (same as SudoConnect).
export async function sudoExec(
  server: Server,
  sudoUser: string,
  sudoPassword: string,
  script: string,
  timeoutMs = 120_000,
): Promise<SudoResult> {
  const ip = server.ip_address ?? ""
  const target = `${sudoUser}@${ip}`
  const portOpt = server.ssh_port ? ["-p", String(server.ssh_port)] : []
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const proc = Bun.spawn(["ssh", ...SSH_OPTS, ...portOpt, target, "sudo -S -p '' bash -s"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: ctrl.signal,
    })
    proc.stdin.write(`${sudoPassword}\n${script}`)
    await proc.stdin.end()
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, stdout, stderr, code }
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message, code: -1 }
  } finally {
    clearTimeout(timer)
  }
}

export interface SiteSizeInput {
  siteId: number
  domain: string
  siteUser: string
  publicFolder?: string // wp-cli runs from files<public_folder> (files/ when "/")
}
export interface SiteSizeEstimate {
  web: number // webroot bytes (uncompressed du) — the files-transfer soft ceiling
  db: number
  total: number
}

// Estimate each source site's payload (webroot bytes + DB bytes) in ONE round trip.
// Webroot via `du -sb /sites/<domain>/files`; DB via `wp db size --size_format=b`
// run as the site user from the site's WP dir (wp-cli.yml resolves Bedrock's web/wp
// path and reads .env). Sites whose probe fails are simply omitted from the map.
export async function estimateSourceSiteSizes(
  server: Server,
  sudoUser: string,
  sudoPassword: string,
  sites: SiteSizeInput[],
): Promise<Map<number, SiteSizeEstimate>> {
  if (sites.length === 0) return new Map()
  const lines = sites.map((s) => {
    const root = `/sites/${s.domain}/files`
    return [
      detectWpDirScript(root, s.publicFolder), // sets D (files root) + W (real WP dir, may be empty)
      `wb=$(du -sb "$D" 2>/dev/null | cut -f1)`,
      `db=$(cd "$W" 2>/dev/null && sudo -u ${shq(s.siteUser)} -H wp db size --size_format=b 2>/dev/null | tr -dc 0-9)`,
      `echo "${s.siteId} \${wb:-0} \${db:-0}"`,
    ].join("; ")
  })
  const res = await sudoExec(server, sudoUser, sudoPassword, lines.join("\n"), 120_000)
  const out = new Map<number, SiteSizeEstimate>()
  if (!res.ok) return out
  for (const line of res.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (!m) continue
    const id = Number(m[1])
    const web = Number(m[2])
    const db = Number(m[3])
    if (web + db > 0) out.set(id, { web, db, total: web + db })
  }
  return out
}

// ---- Standard WP per-site pull chain --------------------------------------
//
// Proven live web1→web2 (2026-06-27). Key lessons baked in:
//   • rsync-over-ssh HANGS in this transport — use tar-over-ssh for files and
//     cat-over-ssh for the DB dump, each bounded with `timeout -k 5 N`.
//   • order is files → re-stamp wp-config → DB import (import needs wp-config
//     already pointing at the dest DB).
//   • the dest authenticates into the SOURCE as the site user via an ephemeral
//     key granted onto the source site user; revoke by the unique comment marker
//     (a full-key grep match is brittle through shell quoting).

export interface SudoCtx {
  server: Server
  sudoUser: string
  sudoPassword: string
}
export type CloneStage = "detect" | "auth" | "build" | "files" | "config" | "db" | "verify" | "revoke"
export type CloneProgress = (stage: CloneStage, status: "start" | "ok" | "fail", detail?: string) => void

// Every sudo script a pull chain runs, reported to the caller for persistent
// logging (the roster truncates errors; the log keeps the full stdout/stderr).
export interface CloneExecRecord {
  domain: string
  stage: CloneStage
  host: string // which end ran it (source/dest server name)
  ok: boolean
  code: number
  ms: number
  script: string
  stdout: string
  stderr: string
}
export type CloneExecLog = (e: CloneExecRecord) => void

// Byte-level transfer progress: the pull materializes a growing file (the tarball
// or DB dump being received), so a SIDECAR poll — an independent, read-only `stat`
// over its own SSH session every few seconds — reads exact bytes-so-far without
// touching the transfer pipeline (progress display must never be able to break a
// transfer). Best-effort: a failed poll is silently skipped.
// `target` is the expected final size when known; `exact` distinguishes a true
// percent (the DB dump is staged+gzipped BEFORE the pull, so its size is a fact)
// from a soft ceiling (files stream gzip-compressed, so the uncompressed du size
// only bounds the transfer — a percent against it would lie).
export type CloneTransfer = (stage: CloneStage, bytes: number, target?: number, exact?: boolean) => void

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Poll `path` on `ctx` until stopped; report each growing size. Returns a stop().
export function pollTransferSize(ctx: SudoCtx, path: string, onBytes: (bytes: number) => void): () => void {
  let live = true
  void (async () => {
    await sleep(4000) // let the transfer begin
    while (live) {
      const r = await exec(ctx, `stat -c %s ${shq(path)} 2>/dev/null || true`, 15_000)
      if (!live) break
      const n = Number(r.stdout.trim())
      if (r.ok && Number.isFinite(n) && n > 0) onBytes(n)
      await sleep(5000)
    }
  })()
  return () => {
    live = false
  }
}

// ---- Webroot: configured vs REAL ------------------------------------------
//
// SpinupWP's public_folder is a *setting* (nginx root = files<public_folder>) — the
// panel never moves files (its UI warns users to move them by hand), so where
// WordPress ACTUALLY lives is a separate fact. The 2026-07-02 web2→mercury failure
// taught us not to hardcode files/; trusting the setting alone is the same trap one
// level up. So the pull chain DETECTS the real WP dir on the source (wp-settings.php
// is the core marker) and, on the dest, normalizes the tree so the files sit where
// the configured public folder expects them — completing the move-the-files step
// SpinupWP leaves to users, instead of cloning a 404.

// "/public/" → "public", "/" or undefined → "" (relative to files/).
export function publicFolderRel(publicFolder?: string): string {
  return (publicFolder ?? "/").replace(/^\/+|\/+$/g, "")
}
export function webrootFor(root: string, publicFolder?: string): string {
  const pf = publicFolderRel(publicFolder)
  return pf ? `${root}/${pf}` : root
}

// Bash fragment: set W to the dir under $D (the files root) that holds
// wp-settings.php — configured-candidate first, then Bedrock's convention
// relative to that candidate, then the root, then a bounded find. Also sets B to
// the Bedrock PROJECT root (composer.json, .env, wp-cli.yml) when core was found
// nested inside a directory literally named "wp" — derived from W rather than a
// second blind search, so it's correct at whatever depth W was actually found,
// and confirmed against composer.json content so a coincidental "wp"-named dir
// in some other stack doesn't get misidentified.
// Leaves W (and B) empty when no WordPress core exists. Exported for the test harness.
export function detectWpDirScript(root: string, publicFolder?: string): string {
  const candidate = webrootFor(root, publicFolder)
  return [
    `D=${shq(root)}; W=""`,
    `[ -f ${shq(candidate)}/wp-settings.php ] && W=${shq(candidate)}`,
    // Bedrock never puts core directly in the public folder — it lives one level
    // down, at {public_folder}/wp/ (the whole point of Bedrock's web/wp + web/app
    // split). Anchoring on the CONFIGURED public folder here — rather than relying
    // solely on the blind find below — finds Bedrock core at any nesting depth,
    // not just the couple of levels the bounded find happens to reach.
    `[ -z "$W" ] && [ -f ${shq(candidate)}/wp/wp-settings.php ] && W=${shq(candidate)}/wp`,
    `[ -z "$W" ] && [ -f "$D/wp-settings.php" ] && W="$D"`,
    `[ -z "$W" ] && { F=$(find "$D" -maxdepth 3 -name wp-settings.php -not -path "*/wp-content/*" -print -quit 2>/dev/null); [ -n "$F" ] && W=$(dirname "$F"); }`,
    `B=""`,
    `[ -n "$W" ] && [ "$(basename "$W")" = "wp" ] && { P=$(dirname "$(dirname "$W")"); [ -f "$P/composer.json" ] && grep -q "roots/bedrock" "$P/composer.json" 2>/dev/null && B="$P"; }`,
  ].join("; ")
}

// Bash fragment: set B to the Bedrock PROJECT root via composer.json — for a
// FRESH git clone, before `composer install` has run. detectWpDirScript's B
// anchors on WordPress core (a directory literally named "wp"), which doesn't
// exist yet at this point — Bedrock's core is a composer dependency, never
// committed to git. composer.json IS present immediately post-clone, so this
// anchors on that instead: the configured public folder's PARENT first (that's
// where composer.json sits, by Bedrock convention — one level above the public
// folder), then the files root itself, then a bounded find. Leaves B empty when
// no Bedrock project is found. Exported for the test harness.
export function detectBedrockRootScript(root: string, publicFolder?: string): string {
  const candidate = webrootFor(root, publicFolder)
  const parent = candidate === root ? root : candidate.slice(0, candidate.lastIndexOf("/"))
  return [
    `D=${shq(root)}; P=${shq(parent)}; B=""`,
    `[ -f "$P/composer.json" ] && grep -q "roots/bedrock" "$P/composer.json" 2>/dev/null && B="$P"`,
    `[ -z "$B" ] && [ "$P" != "$D" ] && [ -f "$D/composer.json" ] && grep -q "roots/bedrock" "$D/composer.json" 2>/dev/null && B="$D"`,
    `[ -z "$B" ] && { F=$(find "$D" -maxdepth 3 -name composer.json -not -path "*/vendor/*" -print -quit 2>/dev/null); [ -n "$F" ] && grep -q "roots/bedrock" "$F" 2>/dev/null && B=$(dirname "$F"); }`,
  ].join("; ")
}

// Bash fragment: sweep everything under `root` into `destWpDir` (the configured
// public folder) — the move-the-files step SpinupWP leaves to users. wp-config.php
// is then placed ONE LEVEL ABOVE the webroot: WordPress's long-standing config-
// outside-the-docroot hardening, the whole point of a public/ layout, and a
// deliberate product stance (see CLAUDE.md "WordPress layout rules"). Root-webroot
// sites never reach this path — their config stays alongside core. Idempotent: a
// tree that already has core at destWpDir is left alone. Exported for the test harness.
export function normalizeWebrootScript(root: string, destWpDir: string): string {
  const parent = destWpDir.slice(0, destWpDir.lastIndexOf("/"))
  return `if [ ! -f ${shq(destWpDir)}/wp-settings.php ]; then cd ${shq(root)}; rm -rf .spinup_normalize; mkdir .spinup_normalize; find . -mindepth 1 -maxdepth 1 ! -name .spinup_normalize -exec mv {} .spinup_normalize/ \\; ; mkdir -p ${shq(destWpDir)}; find .spinup_normalize -mindepth 1 -maxdepth 1 -exec mv {} ${shq(destWpDir)}/ \\; ; rmdir .spinup_normalize; if [ -f ${shq(destWpDir)}/wp-config.php ]; then mv ${shq(destWpDir)}/wp-config.php ${shq(parent)}/wp-config.php; fi; fi`
}

// Decide what the clone does about the webroot, from the DETECTED source layout vs
// the CONFIGURED public folder (both relative to files/, "" = files root):
//   • match → clone as-is.
//   • detected at root, setting deeper → the mid-move SOP state: normalize the dest
//     (sweep files under the setting) so nginx serves the clone.
//   • detected deeper, setting at root → a subdirectory install (root index.php
//     bootstraps core in a subfolder) — a working layout; clone as-is, wp-cli runs
//     from the core dir.
//   • two different non-root dirs → too custom to guess; refuse with a clear error.
// Exported (pure) for the test harness.
export function planWebroot(detectedRel: string, configuredRel: string): { destRel: string; normalize: boolean } | { error: string } {
  if (detectedRel === configuredRel) return { destRel: detectedRel, normalize: false }
  if (detectedRel === "") return { destRel: configuredRel, normalize: true }
  if (configuredRel === "") return { destRel: detectedRel, normalize: false }
  return { error: `WordPress lives at files/${detectedRel} on the source but the public folder setting is /${configuredRel}/ — can't auto-normalize; align them in SpinupWP (or move the files) and retry` }
}

export interface StandardWpPullSpec {
  domain: string
  sourceSiteUser: string
  destSiteUser: string
  destDbName: string
  destDbUser: string
  destDbPassword: string
  publicFolder?: string // source site's public_folder (dest is created with the same)
  approxFilesBytes?: number // Plan's uncompressed webroot size — soft ceiling for the files meter
  repairDestinationDatabase?: boolean
}

// The ephemeral pull key and its authorized_keys marker are PER SITE. They were
// once a single shared /root/.clone_pull — with concurrent sites each auth stage
// regenerated it and each revoke deleted it, breaking every other in-flight site's
// SSH mid-chain (proven live 2026-07-02: one site's db pull got Permission denied
// seconds after another site's auth replaced the key).
function cloneKeyFor(domain: string): string {
  return `/root/.clone_pull_${domain}`
}
function keyMarkerFor(domain: string): string {
  return `spinup-clone-pull-${domain}`
}

function exec(ctx: SudoCtx, script: string, timeoutMs = 600_000) {
  return sudoExec(ctx.server, ctx.sudoUser, ctx.sudoPassword, script, timeoutMs)
}

// The dest pulls the site's files + DB straight from the source (server-to-server,
// nothing through the orchestrator). Files/DB land owned by the dest site user with a
// wp-config re-stamped to the dest DB. Verifies `wp core is-installed`; the HTTP
// `--resolve` check is the caller's (it knows the dest IP). The granted pull key is
// always revoked (best-effort) before returning.
//
// Webroot handling: the REAL source WP dir is detected (stage 0), all source-side
// wp-cli runs there; planWebroot decides whether the dest tree is normalized to the
// CONFIGURED public folder (stage 2); all dest-side wp-cli runs from the resulting
// dir. The result reports both layouts (`sourceWebrootRel`/`destWebrootRel`) for verify.
export async function runStandardWpPull(
  source: SudoCtx,
  dest: SudoCtx,
  spec: StandardWpPullSpec,
  onProgress: CloneProgress = () => {},
  onExec?: CloneExecLog,
  onTransfer?: CloneTransfer,
): Promise<{ ok: boolean; error?: string; sourceWebrootRel?: string; destWebrootRel?: string }> {
  const srcIp = source.server.ip_address ?? ""
  const root = `/sites/${spec.domain}/files`
  const home = `/sites/${spec.domain}`
  const expRel = publicFolderRel(spec.publicFolder) // configured layout — nginx's root on both ends
  const su = spec.sourceSiteUser
  const du = spec.destSiteUser
  const KEY = cloneKeyFor(spec.domain)
  const MARKER = keyMarkerFor(spec.domain)
  const sshk = `ssh -i ${KEY} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10`
  const fail = (stage: CloneStage, msg: string) => {
    onProgress(stage, "fail", msg)
    return { ok: false as const, error: `${stage}: ${msg}` }
  }
  const run = async (stage: CloneStage, ctx: SudoCtx, script: string, timeoutMs?: number) => {
    const t0 = Date.now()
    const r = await exec(ctx, script, timeoutMs)
    onExec?.({ domain: spec.domain, stage, host: ctx.server.name, ok: r.ok, code: r.code, ms: Date.now() - t0, script, stdout: r.stdout, stderr: r.stderr })
    return r
  }

  // 0. detect — find the REAL WP dir on the source (setting and reality can
  // disagree; SpinupWP never moves files). Fails fast before any key is granted.
  onProgress("detect", "start")
  const det = await run("detect", source, `${detectWpDirScript(root, spec.publicFolder)}; echo "WPDIR:$W"`, 30_000)
  const srcWpDir = (det.stdout.match(/^WPDIR:(.*)$/m)?.[1] ?? "").trim()
  if (!det.ok || !srcWpDir) return fail("detect", det.stderr.trim() || `no WordPress core (wp-settings.php) found under ${root} — is this a WordPress site?`)
  const srcRel = srcWpDir === root ? "" : srcWpDir.startsWith(`${root}/`) ? srcWpDir.slice(root.length + 1) : ""
  const plan = planWebroot(srcRel, expRel)
  if ("error" in plan) return fail("detect", plan.error)
  const destWpDir = plan.destRel ? `${root}/${plan.destRel}` : root
  onProgress("detect", "ok", srcRel ? `files/${srcRel}` : "files/")

  try {
    // 1. auth — ephemeral key on dest, granted onto the source site user.
    onProgress("auth", "start")
    const gen = await run("auth", dest, `rm -f ${KEY} ${KEY}.pub; ssh-keygen -t ed25519 -f ${KEY} -N "" -C ${MARKER} >/dev/null 2>&1 && cat ${KEY}.pub`, 30_000)
    const pub = gen.stdout.trim()
    if (!gen.ok || !pub.startsWith("ssh-")) return fail("auth", gen.stderr.trim() || "couldn't generate pull key")
    const grant = await run(
      "auth",
      source,
      `set -e; SSHDIR=${shq(home)}/.ssh; AK=$SSHDIR/authorized_keys; install -d -m 700 -o ${shq(su)} -g ${shq(su)} "$SSHDIR"; touch "$AK"; chown ${shq(su)}:${shq(su)} "$AK"; chmod 600 "$AK"; grep -qxF ${shq(pub)} "$AK" || echo ${shq(pub)} >> "$AK"`,
      30_000,
    )
    if (!grant.ok) return fail("auth", grant.stderr.trim() || "couldn't grant pull key on source")
    onProgress("auth", "ok")

    // 2. files — tar-over-ssh pull → extract → normalize → chown. When the source
    // keeps WP at the files root but the public folder setting is deeper (the
    // mid-move SOP state), the dest tree is swept under the configured folder so
    // nginx (rooted at files<public_folder>) actually serves the clone. wp-config.php
    // may sit in the webroot OR one level above it, so the assertion accepts either.
    onProgress("files", "start")
    const normalize = plan.normalize ? `${normalizeWebrootScript(root, destWpDir)}; ` : ""
    const stopFilesPoll = pollTransferSize(dest, `/tmp/clone_${spec.domain}.tgz`, (b) => onTransfer?.("files", b, spec.approxFilesBytes, false))
    // wp-config.php may live in the webroot or one level above it (the
    // config-above-webroot convention — see CLAUDE.md); never above files/.
    const cfgDirs = [...new Set([destWpDir, destWpDir.slice(0, destWpDir.lastIndexOf("/")), root])].filter((d) => d.length >= root.length)
    const cfgAssert = cfgDirs.map((d) => `test -f ${shq(`${d}/wp-config.php`)}`).join(" || ")
    // tar exit 1 = "some files differ" (a live site touched a file mid-read —
    // every-minute WP cron + bot traffic make this routine); tolerate it but fail
    // on >=2 (real tar errors), 124 (timeout), 255 (ssh). No --warning suppression:
    // the which-file-changed diagnostics belong in the clone log.
    const files = await run(
      "files",
      dest,
      `set -e; rc=0; timeout -k 5 3600 ${sshk} ${shq(su)}@${srcIp} "tar -C ${shq(root)} -czf - --exclude=wp-content/cache ." </dev/null > /tmp/clone_${spec.domain}.tgz || rc=$?; [ "$rc" -ne 124 ] || { echo "file transfer timed out after 60 minutes" >&2; exit 124; }; [ "$rc" -le 1 ] || { echo "tar-over-ssh failed with exit $rc" >&2; exit "$rc"; }; tar -C ${shq(root)} -xzf /tmp/clone_${spec.domain}.tgz; rm -f /tmp/clone_${spec.domain}.tgz; ${normalize}chown -R ${shq(du)}:${shq(du)} ${shq(root)}; test -f ${shq(destWpDir)}/wp-settings.php || { echo "no WordPress core at ${destWpDir} after pull" >&2; exit 65; }; ${cfgAssert} || { echo "no wp-config.php in the webroot or one level above it (under ${root})" >&2; exit 65; }`,
      3_660_000, // outer must exceed the in-script `timeout 3600` so the inner reports a clean 124
    )
    stopFilesPoll()
    if (!files.ok) return fail("files", files.stderr.trim() || "file pull failed")
    onProgress("files", "ok")

    // 3. config — re-stamp DB creds to the dest's. Run from the dest WP dir: wp-cli
    // walks up to find wp-config.php, covering both layouts.
    onProgress("config", "start")
    if (spec.repairDestinationDatabase) {
      const repaired = await run("config", dest, repairDestinationDatabaseScript(spec.destDbName, spec.destDbUser, spec.destDbPassword), 30_000)
      if (!repaired.ok) return fail("config", repaired.stderr.trim() || repaired.stdout.trim() || "couldn't reset the adopted destination database credentials")
    }
    const cfg = await run(
      "config",
      dest,
      `set -e; cd ${shq(destWpDir)}; sudo -u ${shq(du)} -H wp config set DB_NAME ${shq(spec.destDbName)} --type=constant >/dev/null; sudo -u ${shq(du)} -H wp config set DB_USER ${shq(spec.destDbUser)} --type=constant >/dev/null; sudo -u ${shq(du)} -H wp config set DB_PASSWORD ${shq(spec.destDbPassword)} --type=constant >/dev/null; sudo -u ${shq(du)} -H wp db check >/dev/null`,
      60_000,
    )
    if (!cfg.ok) return fail("config", cfg.stderr.trim() || "re-stamp / db check failed")
    onProgress("config", "ok")

    // 4. db — stage on source (clean stream → file), pull, import. The dump runs
    // from the DETECTED source dir; the import from the normalized dest dir.
    onProgress("db", "start")
    const dump = await run(
      "db",
      source,
      `sudo -u ${shq(su)} -H bash -c "cd ${shq(srcWpDir)} && wp --skip-plugins --skip-themes db export ${shq(home)}/.clone_db.sql 2>/dev/null && gzip -f ${shq(home)}/.clone_db.sql && stat -c %s ${shq(home)}/.clone_db.sql.gz"`,
      900_000,
    )
    if (!dump.ok) return fail("db", dump.stderr.trim() || "source db export failed")
    // The staged dump's size is exact — the db meter gets a true percent.
    const dbTarget = Number(dump.stdout.trim().match(/(\d+)\s*$/)?.[1]) || undefined
    const stopDbPoll = pollTransferSize(dest, `/tmp/clone_${spec.domain}.sql.gz`, (b) => onTransfer?.("db", b, dbTarget, true))
    const imp = await run(
      "db",
      dest,
      `set -e; timeout -k 5 300 ${sshk} ${shq(su)}@${srcIp} "cat ${shq(home)}/.clone_db.sql.gz" </dev/null > /tmp/clone_${spec.domain}.sql.gz; gunzip -f /tmp/clone_${spec.domain}.sql.gz; chmod 644 /tmp/clone_${spec.domain}.sql; cd ${shq(destWpDir)}; sudo -u ${shq(du)} -H wp db import /tmp/clone_${spec.domain}.sql >/dev/null; rm -f /tmp/clone_${spec.domain}.sql`,
      360_000, // outer must exceed the in-script `timeout 300`
    )
    stopDbPoll()
    if (!imp.ok) return fail("db", imp.stderr.trim() || "db pull/import failed")
    onProgress("db", "ok")

    // 5. verify — wp-cli on the dest (HTTP --resolve is the caller's).
    onProgress("verify", "start")
    const ver = await run("verify", dest, `cd ${shq(destWpDir)}; sudo -u ${shq(du)} -H wp core is-installed`, 30_000)
    if (!ver.ok) return fail("verify", "wp core is-installed returned false on the dest")
    onProgress("verify", "ok")

    return { ok: true, sourceWebrootRel: srcRel, destWebrootRel: plan.destRel }
  } finally {
    // 6. revoke — always: drop the pull key (by marker) on source, remove the
    // ephemeral key + staged dump on dest. Best-effort.
    onProgress("revoke", "start")
    // sed (not grep -v): grep returns exit 1 when it filters out the only line, which
    // would skip the rewrite and leave the key behind — exactly the case where the
    // source site user has no other keys.
    await run("revoke", source, `AK=${shq(home)}/.ssh/authorized_keys; [ -f "$AK" ] && sed -i ${shq(`/${MARKER}/d`)} "$AK" && chown ${shq(su)}:${shq(su)} "$AK"; rm -f ${shq(home)}/.clone_db.sql.gz`, 30_000).catch(() => {})
    await run("revoke", dest, `rm -f ${KEY} ${KEY}.pub /tmp/clone_${spec.domain}.tgz /tmp/clone_${spec.domain}.sql.gz /tmp/clone_${spec.domain}.sql`, 30_000).catch(() => {})
    onProgress("revoke", "ok")
  }
}

// ---- Bedrock per-site pull chain ------------------------------------------
//
// Differs from Standard WP: the dest is created as a `git` site (the CALLER does the
// POST /sites installation_method:"git"), so SpinupWP clones the repo + the configured
// deploy_script — BUT git/deploy never runs the script (site-creation findings doc), so
// we `composer install` ourselves over SSH to build vendor/ + web/wp. Only the
// gitignored artifacts come from the source: web/app/uploads, auth.json, .env, and the
// DB. The .env is pulled verbatim and its DB_* creds swapped to the dest's (so salts /
// WP_HOME / custom vars are preserved — a true clone of the same domain).
//
// The Bedrock project's actual location under files/ is DETECTED independently on
// each end, not assumed to match — see the "0. detect" step below. wp-cli runs from
// whichever project root was detected there (where wp-cli.yml lives), not a
// hardcoded files/.

export interface BedrockPullSpec {
  domain: string
  sourceSiteUser: string
  destSiteUser: string
  destDbName: string
  destDbUser: string
  destDbPassword: string
  excludeUploads: boolean
  repairDestinationDatabase?: boolean
  publicFolder?: string // a signal, not a fact (CLAUDE.md) — re-verified below, independently, on both ends
}

export async function runBedrockPull(
  source: SudoCtx,
  dest: SudoCtx,
  spec: BedrockPullSpec,
  onProgress: CloneProgress = () => {},
  onExec?: CloneExecLog,
  onTransfer?: CloneTransfer,
): Promise<{ ok: boolean; error?: string }> {
  const srcIp = source.server.ip_address ?? ""
  const root = `/sites/${spec.domain}/files` // files root — the Bedrock project itself may be nested under this
  const home = `/sites/${spec.domain}`
  const su = spec.sourceSiteUser
  const du = spec.destSiteUser
  const tmp = `/tmp/clone_${spec.domain}`
  const KEY = cloneKeyFor(spec.domain)
  const MARKER = keyMarkerFor(spec.domain)
  const sshk = `ssh -i ${KEY} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10`
  const remote = (cmd: string) => `${sshk} ${shq(su)}@${srcIp} ${shq(cmd)} </dev/null`
  const fail = (stage: CloneStage, msg: string) => {
    onProgress(stage, "fail", msg)
    return { ok: false as const, error: `${stage}: ${msg}` }
  }
  const run = async (stage: CloneStage, ctx: SudoCtx, script: string, timeoutMs?: number) => {
    const t0 = Date.now()
    const r = await exec(ctx, script, timeoutMs)
    onExec?.({ domain: spec.domain, stage, host: ctx.server.name, ok: r.ok, code: r.code, ms: Date.now() - t0, script, stdout: r.stdout, stderr: r.stderr })
    return r
  }

  try {
    // 0. detect — locate the real Bedrock project root on BOTH ends independently
    //    (public_folder is a setting, not a fact — see CLAUDE.md). The two ends need
    //    different anchors: the SOURCE already has WordPress core built, so it
    //    anchors on wp-settings.php (detectWpDirScript). The DEST was just git-cloned
    //    and has NOT run `composer install` yet — core doesn't exist there (it's a
    //    composer dependency, never committed), so nothing to anchor detection on
    //    except composer.json, which IS present immediately post-clone
    //    (detectBedrockRootScript). We do NOT assume the dest mirrors whatever the
    //    source happened to detect — its structure comes from the git repo's own
    //    content, which can legitimately diverge from the source's on-disk state.
    onProgress("detect", "start")
    const det = await run("detect", source, `${detectWpDirScript(root, spec.publicFolder)}; echo "WPCORE:$W"; echo "BEDROCKROOT:$B"`, 30_000)
    const wpCore = (det.stdout.match(/^WPCORE:(.*)$/m)?.[1] ?? "").trim()
    const srcProjectRoot = (det.stdout.match(/^BEDROCKROOT:(.*)$/m)?.[1] ?? "").trim()
    if (!det.ok || !wpCore || !srcProjectRoot) {
      return fail("detect", `couldn't find a Bedrock project (composer.json + WordPress core) under ${root} on the source — is the public folder set correctly?`)
    }
    const webDir = wpCore.slice(0, wpCore.lastIndexOf("/")) // wpCore's parent — the public folder, whatever it's actually named

    // The dest's webroot is fixed by what we told SpinupWP at site-creation time
    // (public_folder), which is what nginx will actually serve — composer install
    // MUST target here for the site to work, regardless of the repo's own internal
    // wordpress-install-dir config. Its PARENT (the project root: composer.json,
    // .env) is what needs re-detecting, since that's a fact about the repo's
    // content, not something either of us configured.
    const destWebDir = webrootFor(root, spec.publicFolder)
    const destProjectRootExpected = destWebDir === root ? root : destWebDir.slice(0, destWebDir.lastIndexOf("/"))
    const destDet = await run("detect", dest, `${detectBedrockRootScript(root, spec.publicFolder)}; echo "BEDROCKROOT:$B"`, 30_000)
    const destProjectRoot = (destDet.stdout.match(/^BEDROCKROOT:(.*)$/m)?.[1] ?? "").trim()
    if (!destDet.ok || !destProjectRoot) {
      return fail("detect", `couldn't find a Bedrock project (composer.json) under ${root} on the destination — did the git clone complete?`)
    }
    if (destProjectRoot !== destProjectRootExpected) {
      return fail(
        "detect",
        `the site's git repo layout doesn't match its configured Public Folder (repo has composer.json at ${destProjectRoot}, but Public Folder implies ${destProjectRootExpected}) — align them and retry`,
      )
    }
    onProgress("detect", "ok")

    // 1. auth — ephemeral key on dest, granted onto the source site user.
    onProgress("auth", "start")
    const gen = await run("auth", dest, `rm -f ${KEY} ${KEY}.pub; ssh-keygen -t ed25519 -f ${KEY} -N "" -C ${MARKER} >/dev/null 2>&1 && cat ${KEY}.pub`, 30_000)
    const pub = gen.stdout.trim()
    if (!gen.ok || !pub.startsWith("ssh-")) return fail("auth", gen.stderr.trim() || "couldn't generate pull key")
    const grant = await run(
      "auth",
      source,
      `set -e; SSHDIR=${shq(home)}/.ssh; AK=$SSHDIR/authorized_keys; install -d -m 700 -o ${shq(su)} -g ${shq(su)} "$SSHDIR"; touch "$AK"; chown ${shq(su)}:${shq(su)} "$AK"; chmod 600 "$AK"; grep -qxF ${shq(pub)} "$AK" || echo ${shq(pub)} >> "$AK"`,
      30_000,
    )
    if (!grant.ok) return fail("auth", grant.stderr.trim() || "couldn't grant pull key on source")
    onProgress("auth", "ok")

    // 2. config — pull source .env verbatim and swap DB_* (and any DATABASE_URL)
    // to the destination credentials before Composer. Bedrock post-install hooks
    // commonly boot WordPress, so running Composer first leaves the clone with an
    // empty/missing DB config and fails before uploads or the database can transfer.
    onProgress("config", "start")
    if (spec.repairDestinationDatabase) {
      const repaired = await run("config", dest, repairDestinationDatabaseScript(spec.destDbName, spec.destDbUser, spec.destDbPassword), 30_000)
      if (!repaired.ok) return fail("config", repaired.stderr.trim() || repaired.stdout.trim() || "couldn't reset the adopted destination database credentials")
    }
    const cfg = await run(
      "config",
      dest,
      [
        `set -e`,
        `${remote(`cat ${shq(`${srcProjectRoot}/.env`)}`)} > ${tmp}_env`,
        `test -s ${tmp}_env`,
        // Drop existing DB assignments (commented or not) + DATABASE_URL, then append canonical creds.
        `sed -i -E '/^[[:space:]]*#?[[:space:]]*(DB_NAME|DB_USER|DB_PASSWORD|DB_HOST|DATABASE_URL)[[:space:]]*=/d' ${tmp}_env`,
        `printf "\\nDB_NAME='%s'\\nDB_USER='%s'\\nDB_PASSWORD='%s'\\nDB_HOST='localhost'\\n" ${shq(spec.destDbName)} ${shq(spec.destDbUser)} ${shq(spec.destDbPassword)} >> ${tmp}_env`,
        `install -m 640 -o ${shq(du)} -g ${shq(du)} ${tmp}_env ${shq(`${destProjectRoot}/.env`)}`,
        `rm -f ${tmp}_env`,
      ].join("; "),
      60_000,
    )
    if (!cfg.ok) return fail("config", cfg.stderr.trim() || ".env re-stamp / db check failed")
    onProgress("config", "ok")

    // 3. build — pull project and site-scoped Composer auth first (private package
    // repos use either location), then build vendor/ + web/wp without scripts.
    // Bedrock post-install hooks can boot WordPress before the source DB is imported.
    onProgress("build", "start")
    const authPull = await run(
      "build",
      dest,
      `set -e; ${remote(`cat ${shq(`${srcProjectRoot}/auth.json`)} 2>/dev/null`)} > ${tmp}_auth.json || true; if [ -s ${tmp}_auth.json ]; then install -m 640 -o ${shq(du)} -g ${shq(du)} ${tmp}_auth.json ${shq(`${destProjectRoot}/auth.json`)}; fi; rm -f ${tmp}_auth.json`,
      120_000,
    )
    if (!authPull.ok) return fail("build", authPull.stderr.trim() || "auth.json pull failed")
    const composerAuthPull = await run(
      "build",
      dest,
      `set -e; ${remote(`cat ${shq(`${home}/.config/composer/auth.json`)} 2>/dev/null`)} > ${tmp}_composer_auth.json || true; if [ -s ${tmp}_composer_auth.json ]; then install -d -m 700 -o ${shq(du)} -g ${shq(du)} ${shq(`${home}/.config/composer`)}; install -m 600 -o ${shq(du)} -g ${shq(du)} ${tmp}_composer_auth.json ${shq(`${home}/.config/composer/auth.json`)}; fi; rm -f ${tmp}_composer_auth.json`,
      120_000,
    )
    if (!composerAuthPull.ok) return fail("build", composerAuthPull.stderr.trim() || "Composer auth pull failed")
    const composer = await run(
      "build",
      dest,
      `set -e; cd ${shq(destProjectRoot)}; sudo -u ${shq(du)} -H bash -lc 'composer install -o --no-dev --no-interaction --no-scripts' 2>&1; test -d ${shq(`${destWebDir}/wp`)}`,
      600_000,
    )
    if (!composer.ok) return fail("build", (composer.stdout + composer.stderr).trim().split("\n").slice(-3).join(" ") || "composer install failed")
    // A just-created/adopted Bedrock site may not have web/wp until Composer
    // finishes. Check the destination DB only after that no-script build.
    const dbCheck = await run("config", dest, `cd ${shq(destProjectRoot)}; sudo -u ${shq(du)} -H wp db check`, 30_000)
    if (!dbCheck.ok) return fail("config", dbCheck.stderr.trim() || dbCheck.stdout.trim() || "destination DB check failed")
    onProgress("build", "ok")

    // 4. files — pull {web}/app/uploads (unless excluded), `web` being whatever the
    //    detected public folder is actually named — which can differ in nesting
    //    depth between source and dest (the repo's own content vs. how deep the
    //    source's on-disk state happens to be). Archiving/extracting relative to
    //    EACH side's own web dir (not `root`) with a fixed member name sidesteps
    //    that — the two ends never need to agree on a shared relative path. Best-
    //    effort: a site with no uploads dir yields an empty stream we simply skip.
    onProgress("files", "start")
    if (!spec.excludeUploads) {
      const stopUpPoll = pollTransferSize(dest, `${tmp}_up.tgz`, (b) => onTransfer?.("files", b))
      const up = await run(
        "files",
        dest,
        `set -e; timeout -k 5 3600 ${remote(`[ -d ${shq(`${webDir}/app/uploads`)} ] && tar -C ${shq(webDir)} --warning=no-file-changed -czf - app/uploads || true`)} > ${tmp}_up.tgz; if [ -s ${tmp}_up.tgz ]; then tar -C ${shq(destWebDir)} -xzf ${tmp}_up.tgz && chown -R ${shq(du)}:${shq(du)} ${shq(`${destWebDir}/app/uploads`)}; fi; rm -f ${tmp}_up.tgz`,
        3_660_000, // outer must exceed the in-script `timeout 3600` so the inner reports a clean 124
      )
      stopUpPoll()
      if (!up.ok) return fail("files", up.stderr.trim() || "uploads pull failed")
    }
    onProgress("files", "ok")

    // 5. db — stage on source (clean stream → file), pull, import.
    onProgress("db", "start")
    const dump = await run(
      "db",
      source,
      `sudo -u ${shq(su)} -H bash -c "cd ${shq(srcProjectRoot)} && wp --skip-plugins --skip-themes db export ${shq(home)}/.clone_db.sql 2>/dev/null && gzip -f ${shq(home)}/.clone_db.sql && stat -c %s ${shq(home)}/.clone_db.sql.gz"`,
      900_000,
    )
    if (!dump.ok) return fail("db", dump.stderr.trim() || "source db export failed")
    const dbTarget = Number(dump.stdout.trim().match(/(\d+)\s*$/)?.[1]) || undefined
    const stopDbPoll = pollTransferSize(dest, `${tmp}.sql.gz`, (b) => onTransfer?.("db", b, dbTarget, true))
    const imp = await run(
      "db",
      dest,
      `set -e; timeout -k 5 300 ${remote(`cat ${shq(`${home}/.clone_db.sql.gz`)}`)} > ${tmp}.sql.gz; gunzip -f ${tmp}.sql.gz; chmod 644 ${tmp}.sql; cd ${shq(destProjectRoot)}; sudo -u ${shq(du)} -H wp db import ${tmp}.sql >/dev/null; rm -f ${tmp}.sql`,
      360_000, // outer must exceed the in-script `timeout 300`
    )
    stopDbPoll()
    if (!imp.ok) return fail("db", imp.stderr.trim() || "db pull/import failed")
    onProgress("db", "ok")

    // 6. deploy hooks — database-dependent Composer hooks run only after import.
    onProgress("build", "start")
    const hooks = await run(
      "build",
      dest,
      `set -e; install -d -m 775 -o ${shq(du)} -g ${shq(du)} ${shq(`${home}/tmp`)}; cd ${shq(destProjectRoot)}; if grep -q '"post-install-cmd"' composer.json; then sudo -u ${shq(du)} -H bash -lc 'composer run post-install-cmd --no-interaction' 2>&1; fi`,
      300_000,
    )
    // These are application-specific deployment conveniences (plugin installs,
    // license-driven updates, cache warmers), not clone integrity. The copied
    // files and imported DB have already succeeded; keep the warning in the
    // stage log but let the final WordPress verification decide clone success.
    if (!hooks.ok) onProgress("build", "ok", `post-install hook warning: ${(hooks.stdout + hooks.stderr).trim().split("\n").slice(-1)[0] || "failed"}`)
    onProgress("build", "ok")

    // 7. verify — wp-cli on the dest (HTTP --resolve is the caller's).
    onProgress("verify", "start")
    const ver = await run("verify", dest, `cd ${shq(destProjectRoot)}; sudo -u ${shq(du)} -H wp core is-installed`, 30_000)
    if (!ver.ok) return fail("verify", "wp core is-installed returned false on the dest")
    onProgress("verify", "ok")

    return { ok: true }
  } finally {
    // 7. revoke — drop the pull key (by marker) on source, clean dest temp + staged dump.
    onProgress("revoke", "start")
    await run("revoke", source, `AK=${shq(home)}/.ssh/authorized_keys; [ -f "$AK" ] && sed -i ${shq(`/${MARKER}/d`)} "$AK" && chown ${shq(su)}:${shq(su)} "$AK"; rm -f ${shq(home)}/.clone_db.sql.gz`, 30_000).catch(() => {})
    await run("revoke", dest, `rm -f ${KEY} ${KEY}.pub ${tmp}_auth.json ${tmp}_composer_auth.json ${tmp}_up.tgz ${tmp}_env ${tmp}.sql.gz ${tmp}.sql`, 30_000).catch(() => {})
    onProgress("revoke", "ok")
  }
}

// Cheap pre-flight, before a Bedrock clone creates anything: does the SOURCE's
// on-disk project match its OWN configured Public Folder? A heuristic, not a
// guarantee — the destination's real structure comes from the git repo's
// committed content, which this can't inspect directly, so it can't promise the
// clone will succeed. But in the ordinary case (the source's files came from
// composer-installing that same repo) the two agree, so a mismatch here reliably
// predicts the same failure runBedrockPull's own "detect" step would hit later —
// just BEFORE a destination site (and its git clone) gets created for nothing.
// Silent no-op for anything that isn't a detectable Bedrock install; that's
// covered by the pull chain's own detection, not this pre-check's job.
export async function preflightBedrockSource(source: SudoCtx, spec: { domain: string; publicFolder?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = `/sites/${spec.domain}/files`
  const expectedWebDir = webrootFor(root, spec.publicFolder)
  const expectedProjectRoot = expectedWebDir === root ? root : expectedWebDir.slice(0, expectedWebDir.lastIndexOf("/"))
  const r = await exec(source, `${detectWpDirScript(root, spec.publicFolder)}; echo "BEDROCKROOT:$B"`, 30_000)
  const detected = (r.stdout.match(/^BEDROCKROOT:(.*)$/m)?.[1] ?? "").trim()
  if (!r.ok || !detected) return { ok: true }
  if (detected !== expectedProjectRoot) {
    return {
      ok: false,
      error: `this site's actual files (Bedrock project at ${detected}) don't match its configured Public Folder (implies ${expectedProjectRoot}) — align them and retry`,
    }
  }
  return { ok: true }
}

// ---- Files-only pull chain (non-WP sites: redirect shells, static/PHP sites) --
//
// The same hardened transport as the Standard-WP files stage (per-site key,
// tolerant tar, 60-min budget, sidecar byte meter) with everything WordPress
// removed: no detect, no wp-config re-stamp, no database. The dest site is
// created blank with NO database block (the caller's job). Verification is
// file-count/size + HTTP, not wp-cli — see verifyFilesClone.

export interface FilesOnlyPullSpec {
  domain: string
  sourceSiteUser: string
  destSiteUser: string
  approxFilesBytes?: number // Plan's uncompressed size — soft ceiling for the meter
}

export async function runFilesOnlyPull(
  source: SudoCtx,
  dest: SudoCtx,
  spec: FilesOnlyPullSpec,
  onProgress: CloneProgress = () => {},
  onExec?: CloneExecLog,
  onTransfer?: CloneTransfer,
): Promise<{ ok: boolean; error?: string }> {
  const srcIp = source.server.ip_address ?? ""
  const root = `/sites/${spec.domain}/files`
  const home = `/sites/${spec.domain}`
  const su = spec.sourceSiteUser
  const du = spec.destSiteUser
  const KEY = cloneKeyFor(spec.domain)
  const MARKER = keyMarkerFor(spec.domain)
  const sshk = `ssh -i ${KEY} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10`
  const fail = (stage: CloneStage, msg: string) => {
    onProgress(stage, "fail", msg)
    return { ok: false as const, error: `${stage}: ${msg}` }
  }
  const run = async (stage: CloneStage, ctx: SudoCtx, script: string, timeoutMs?: number) => {
    const t0 = Date.now()
    const r = await exec(ctx, script, timeoutMs)
    onExec?.({ domain: spec.domain, stage, host: ctx.server.name, ok: r.ok, code: r.code, ms: Date.now() - t0, script, stdout: r.stdout, stderr: r.stderr })
    return r
  }

  try {
    // 1. auth — ephemeral per-site key on dest, granted onto the source site user.
    onProgress("auth", "start")
    const gen = await run("auth", dest, `rm -f ${KEY} ${KEY}.pub; ssh-keygen -t ed25519 -f ${KEY} -N "" -C ${MARKER} >/dev/null 2>&1 && cat ${KEY}.pub`, 30_000)
    const pub = gen.stdout.trim()
    if (!gen.ok || !pub.startsWith("ssh-")) return fail("auth", gen.stderr.trim() || "couldn't generate pull key")
    const grant = await run(
      "auth",
      source,
      `set -e; SSHDIR=${shq(home)}/.ssh; AK=$SSHDIR/authorized_keys; install -d -m 700 -o ${shq(su)} -g ${shq(su)} "$SSHDIR"; touch "$AK"; chown ${shq(su)}:${shq(su)} "$AK"; chmod 600 "$AK"; grep -qxF ${shq(pub)} "$AK" || echo ${shq(pub)} >> "$AK"`,
      30_000,
    )
    if (!grant.ok) return fail("auth", grant.stderr.trim() || "couldn't grant pull key on source")
    onProgress("auth", "ok")

    // 2. files — the whole files/ tree, verbatim (whatever layout the site uses).
    onProgress("files", "start")
    const stopPoll = pollTransferSize(dest, `/tmp/clone_${spec.domain}.tgz`, (b) => onTransfer?.("files", b, spec.approxFilesBytes, false))
    const files = await run(
      "files",
      dest,
      `set -e; rc=0; timeout -k 5 3600 ${sshk} ${shq(su)}@${srcIp} "tar -C ${shq(root)} -czf - ." </dev/null > /tmp/clone_${spec.domain}.tgz || rc=$?; [ "$rc" -ne 124 ] || { echo "file transfer timed out after 60 minutes" >&2; exit 124; }; [ "$rc" -le 1 ] || { echo "tar-over-ssh failed with exit $rc" >&2; exit "$rc"; }; tar -C ${shq(root)} -xzf /tmp/clone_${spec.domain}.tgz; rm -f /tmp/clone_${spec.domain}.tgz; chown -R ${shq(du)}:${shq(du)} ${shq(root)}; [ -n "$(ls -A ${shq(root)} 2>/dev/null)" ] || { echo "files/ is empty after pull" >&2; exit 65; }`,
      3_660_000, // outer must exceed the in-script `timeout 3600`
    )
    stopPoll()
    if (!files.ok) return fail("files", files.stderr.trim() || "file pull failed")
    onProgress("files", "ok")

    return { ok: true }
  } finally {
    onProgress("revoke", "start")
    await run("revoke", source, `AK=${shq(home)}/.ssh/authorized_keys; [ -f "$AK" ] && sed -i ${shq(`/${MARKER}/d`)} "$AK" && chown ${shq(su)}:${shq(su)} "$AK"`, 30_000).catch(() => {})
    await run("revoke", dest, `rm -f ${KEY} ${KEY}.pub /tmp/clone_${spec.domain}.tgz`, 30_000).catch(() => {})
    onProgress("revoke", "ok")
  }
}

// Verify a files-only clone: file count + total bytes on each side, plus the HTTP
// check via the dest IP. Counts must match exactly; bytes get a small tolerance
// (a growing log on the live source shouldn't flunk the clone).
export async function verifyFilesClone(source: SudoCtx, dest: SudoCtx, spec: { domain: string; destIp: string }): Promise<VerifyResult> {
  const root = `/sites/${spec.domain}/files`
  const script = `echo "files=$(find ${shq(root)} -type f 2>/dev/null | wc -l)"; echo "bytes=$(du -sb ${shq(root)} 2>/dev/null | cut -f1)"`
  const parse = (out: string): Record<string, string> => {
    const o: Record<string, string> = {}
    for (const line of out.split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m) o[m[1]!] = (m[2] ?? "").trim()
    }
    return o
  }
  const [sr, dr, http] = await Promise.all([exec(source, script, 60_000), exec(dest, script, 60_000), curlStatus(spec.domain, spec.destIp)])
  const sf = parse(sr.stdout)
  const cf = parse(dr.stdout)
  const checks: VerifyCheck[] = []
  checks.push({ key: "http", label: "Clone serves (HTTP)", source: "—", clone: http, ok: /^[23]\d\d$/.test(http) })
  checks.push({ key: "files", label: "Files", source: sf.files ?? "—", clone: cf.files ?? "—", ok: !!sf.files && sf.files === cf.files })
  const sb = Number(sf.bytes)
  const cb = Number(cf.bytes)
  const bytesOk = Number.isFinite(sb) && Number.isFinite(cb) && sb > 0 && Math.abs(sb - cb) <= Math.max(4096, sb * 0.01)
  checks.push({ key: "bytes", label: "Total size", source: sf.bytes ?? "—", clone: cf.bytes ?? "—", ok: bytesOk })
  return { ok: checks.every((c) => c.ok), checks }
}

// ---- Verify a cloned site (slice 5) ---------------------------------------
//
// Read-only confirmation that the clone matches the source: compare a handful of
// wp-cli facts on each side (run as the respective site user from the Bedrock/Std-WP
// root, identical to the pull) plus an HTTP --resolve fetch of the clone via the dest
// IP. Nothing is mutated; safe to re-run. wp-cli runs the same from both stacks
// because both resolve via the site's wp-cli.yml / wp-config from /sites/{domain}/files.

export interface VerifyCheck {
  key: string
  label: string
  source: string
  clone: string
  ok: boolean
}
export interface VerifyResult {
  ok: boolean
  checks: VerifyCheck[]
}
export interface VerifySpec {
  domain: string
  sourceSiteUser: string
  destSiteUser: string
  destIp: string
  publicFolder?: string // configured public folder — fallback when the pull's rels are unknown
  sourceWebrootRel?: string // DETECTED source layout from the pull ("" = files root)
  destWebrootRel?: string // the CLONE's WP dir from the pull (post-normalization)
  phpVersion?: string | null // the site's configured PHP version — see wpCli.ts
}

// One round-trip per side: collect labeled wp-cli facts as `key=value` lines.
// --skip-plugins/--skip-themes: no plugin code runs per invocation (a plugin making a
// stalled outbound call once ate the whole budget and cut the facts off mid-script) —
// and the flags are identical on both sides, so every count stays comparable. The
// trailing `eof` sentinel is how verifyClone tells "read got cut off" from "differs".
// wp-cli is pinned to the site's OWN configured PHP-CLI (wpCliResolveScript) rather
// than bare `wp` — see wpCli.ts for why (a server's system-default PHP can silently
// differ from, and be missing extensions present in, the site's actual version).
async function wpFacts(ctx: SudoCtx, root: string, user: string, phpVersion?: string | null): Promise<Record<string, string>> {
  const script = [
    `cd ${shq(root)} 2>/dev/null || exit 0`,
    wpCliResolveScript(phpVersion),
    `u() { sudo -u ${shq(user)} -H "$PHP" "$WP" --skip-plugins --skip-themes "$@" 2>/dev/null; }`,
    `echo "core=$(u core version)"`,
    `echo "posts=$(u post list --post_type=any --format=count)"`,
    `echo "pages=$(u post list --post_type=page --format=count)"`,
    `echo "users=$(u user list --format=count)"`,
    `echo "plugins=$(u plugin list --status=active --format=count)"`,
    `echo "siteurl=$(u option get siteurl)"`,
    `echo "home=$(u option get home)"`,
    `echo "eof=1"`,
  ].join("\n")
  const res = await exec(ctx, script, 120_000)
  const out: Record<string, string> = {}
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) out[m[1]] = (m[2] ?? "").trim()
  }
  return out
}

// HTTP status of the clone fetched via the dest IP (DNS-independent, like the manual
// `curl --resolve` checks). 2xx/3xx counts as serving.
async function curlStatus(domain: string, ip: string): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["curl", "-sS", "-o", "/dev/null", "-m", "20", "-w", "%{http_code}", "-L", "--resolve", `${domain}:80:${ip}`, "--resolve", `${domain}:443:${ip}`, `http://${domain}/`],
      { stdout: "pipe", stderr: "pipe" },
    )
    const code = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    return code || "—"
  } catch {
    return "err"
  }
}

export async function verifyClone(source: SudoCtx, dest: SudoCtx, spec: VerifySpec): Promise<VerifyResult> {
  const root = `/sites/${spec.domain}/files`
  // Source facts read from where WP was DETECTED during the pull; clone facts from
  // the pull's resulting dir — after a normalizing pull these differ.
  const dirFor = (rel: string | undefined) => (rel != null ? (rel ? `${root}/${rel}` : root) : webrootFor(root, spec.publicFolder))
  const srcDir = dirFor(spec.sourceWebrootRel)
  const destDir = dirFor(spec.destWebrootRel)
  const [sf, cf, http] = await Promise.all([
    wpFacts(source, srcDir, spec.sourceSiteUser, spec.phpVersion),
    wpFacts(dest, destDir, spec.destSiteUser, spec.phpVersion),
    curlStatus(spec.domain, spec.destIp),
  ])
  // A missing tail sentinel means the facts script was cut off partway (timeout, a
  // stalled command) — fail the verify loudly instead of rendering the missing tail
  // as misleading ✕ "–" mismatch rows (which read as "the clone differs").
  if (sf.eof !== "1" || cf.eof !== "1") {
    const side = sf.eof !== "1" ? "source" : "clone"
    throw new Error(`couldn't read the ${side}'s WordPress facts (the wp-cli read was cut off) — press v to re-run`)
  }
  // `core` succeeding (a file read, no DB) while EVERY database-backed fact comes
  // back empty is a distinct signature from a real content difference (which shows
  // differing NON-empty values, not blanks) — it means wp-cli's PHP-CLI couldn't
  // reach the database on that side, commonly a missing `mysqli` extension for
  // whatever PHP version it resolved to (see wpCli.ts). Surface that plainly
  // instead of a wall of misleading ✕ rows implying the clone lost data.
  const dbFields = ["posts", "pages", "users", "plugins", "siteurl", "home"] as const
  const looksBroken = (f: Record<string, string>) => !!f.core && dbFields.every((k) => !f[k])
  const srcBroken = looksBroken(sf)
  const cloneBroken = looksBroken(cf)
  if (srcBroken || cloneBroken) {
    const side = srcBroken && cloneBroken ? "both the source and the clone" : srcBroken ? "the source" : "the clone"
    throw new Error(
      `wp-cli can't reach ${side}'s database over PHP (commonly a missing "mysqli" extension for whatever PHP-CLI it resolved to) — this looks like a server/PHP-CLI environment issue, not an actual data difference.`,
    )
  }
  const checks: VerifyCheck[] = []
  checks.push({ key: "http", label: "Clone serves (HTTP)", source: "—", clone: http, ok: /^[23]\d\d$/.test(http) })
  const cmp = (key: string, label: string) => {
    const s = sf[key] ?? ""
    const c = cf[key] ?? ""
    checks.push({ key, label, source: s || "—", clone: c || "—", ok: s !== "" && s === c })
  }
  cmp("core", "WordPress version")
  cmp("posts", "Posts")
  cmp("pages", "Pages")
  cmp("users", "Users")
  cmp("plugins", "Active plugins")
  cmp("siteurl", "Site URL")
  cmp("home", "Home URL")
  return { ok: checks.every((c) => c.ok), checks }
}

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

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"]

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
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
function webrootFor(root: string, publicFolder?: string): string {
  const pf = publicFolderRel(publicFolder)
  return pf ? `${root}/${pf}` : root
}

// Bash fragment: set W to the dir under $D (the files root) that holds
// wp-settings.php — configured-candidate first, then the root, then a bounded find.
// Leaves W empty when no WordPress core exists. Exported for the test harness.
export function detectWpDirScript(root: string, publicFolder?: string): string {
  const candidate = webrootFor(root, publicFolder)
  return [
    `D=${shq(root)}; W=""`,
    `[ -f ${shq(candidate)}/wp-settings.php ] && W=${shq(candidate)}`,
    `[ -z "$W" ] && [ -f "$D/wp-settings.php" ] && W="$D"`,
    `[ -z "$W" ] && { F=$(find "$D" -maxdepth 3 -name wp-settings.php -not -path "*/wp-content/*" -print -quit 2>/dev/null); [ -n "$F" ] && W=$(dirname "$F"); }`,
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
// WP_HOME / custom vars are preserved — a true clone of the same domain). wp-cli runs
// from the Bedrock root (files/, where wp-cli.yml points at web/wp).

export interface BedrockPullSpec {
  domain: string
  sourceSiteUser: string
  destSiteUser: string
  destDbName: string
  destDbUser: string
  destDbPassword: string
  excludeUploads: boolean
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
  const root = `/sites/${spec.domain}/files` // Bedrock project root (composer.json, web/, .env)
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

    // 2. build — pull auth.json first (private composer repos need it), then
    //    `composer install` to build vendor/ + web/wp (git/deploy won't, per findings).
    onProgress("build", "start")
    const authPull = await run(
      "build",
      dest,
      `set -e; ${remote(`cat ${shq(`${root}/auth.json`)} 2>/dev/null`)} > ${tmp}_auth.json || true; if [ -s ${tmp}_auth.json ]; then install -m 640 -o ${shq(du)} -g ${shq(du)} ${tmp}_auth.json ${shq(`${root}/auth.json`)}; fi; rm -f ${tmp}_auth.json`,
      120_000,
    )
    if (!authPull.ok) return fail("build", authPull.stderr.trim() || "auth.json pull failed")
    const composer = await run(
      "build",
      dest,
      `set -e; cd ${shq(root)}; sudo -u ${shq(du)} -H bash -lc 'composer install -o --no-dev --no-interaction' 2>&1; test -d ${shq(`${root}/web/wp`)}`,
      600_000,
    )
    if (!composer.ok) return fail("build", (composer.stdout + composer.stderr).trim().split("\n").slice(-3).join(" ") || "composer install failed")
    onProgress("build", "ok")

    // 3. files — pull web/app/uploads (unless excluded). Best-effort: a site with no
    //    uploads dir yields an empty stream we simply skip.
    onProgress("files", "start")
    if (!spec.excludeUploads) {
      const stopUpPoll = pollTransferSize(dest, `${tmp}_up.tgz`, (b) => onTransfer?.("files", b))
      const up = await run(
        "files",
        dest,
        `set -e; timeout -k 5 3600 ${remote(`[ -d ${shq(`${root}/web/app/uploads`)} ] && tar -C ${shq(root)} --warning=no-file-changed -czf - web/app/uploads || true`)} > ${tmp}_up.tgz; if [ -s ${tmp}_up.tgz ]; then tar -C ${shq(root)} -xzf ${tmp}_up.tgz && chown -R ${shq(du)}:${shq(du)} ${shq(`${root}/web/app/uploads`)}; fi; rm -f ${tmp}_up.tgz`,
        3_660_000, // outer must exceed the in-script `timeout 3600` so the inner reports a clean 124
      )
      stopUpPoll()
      if (!up.ok) return fail("files", up.stderr.trim() || "uploads pull failed")
    }
    onProgress("files", "ok")

    // 4. config — pull source .env verbatim, swap DB_* (and any DATABASE_URL) to the
    //    dest creds, keep everything else (salts, WP_HOME, custom vars). Then db check.
    onProgress("config", "start")
    const cfg = await run(
      "config",
      dest,
      [
        `set -e`,
        `${remote(`cat ${shq(`${root}/.env`)}`)} > ${tmp}_env`,
        `test -s ${tmp}_env`,
        // drop existing DB assignments (commented or not) + DATABASE_URL, then append canonical creds.
        `sed -i -E '/^[[:space:]]*#?[[:space:]]*(DB_NAME|DB_USER|DB_PASSWORD|DB_HOST|DATABASE_URL)[[:space:]]*=/d' ${tmp}_env`,
        `printf "\\nDB_NAME='%s'\\nDB_USER='%s'\\nDB_PASSWORD='%s'\\nDB_HOST='localhost'\\n" ${shq(spec.destDbName)} ${shq(spec.destDbUser)} ${shq(spec.destDbPassword)} >> ${tmp}_env`,
        `install -m 640 -o ${shq(du)} -g ${shq(du)} ${tmp}_env ${shq(`${root}/.env`)}`,
        `rm -f ${tmp}_env`,
        `cd ${shq(root)}; sudo -u ${shq(du)} -H wp db check >/dev/null 2>&1`,
      ].join("; "),
      60_000,
    )
    if (!cfg.ok) return fail("config", cfg.stderr.trim() || ".env re-stamp / db check failed")
    onProgress("config", "ok")

    // 5. db — stage on source (clean stream → file), pull, import.
    onProgress("db", "start")
    const dump = await run(
      "db",
      source,
      `sudo -u ${shq(su)} -H bash -c "cd ${shq(root)} && wp --skip-plugins --skip-themes db export ${shq(home)}/.clone_db.sql 2>/dev/null && gzip -f ${shq(home)}/.clone_db.sql && stat -c %s ${shq(home)}/.clone_db.sql.gz"`,
      900_000,
    )
    if (!dump.ok) return fail("db", dump.stderr.trim() || "source db export failed")
    const dbTarget = Number(dump.stdout.trim().match(/(\d+)\s*$/)?.[1]) || undefined
    const stopDbPoll = pollTransferSize(dest, `${tmp}.sql.gz`, (b) => onTransfer?.("db", b, dbTarget, true))
    const imp = await run(
      "db",
      dest,
      `set -e; timeout -k 5 300 ${remote(`cat ${shq(`${home}/.clone_db.sql.gz`)}`)} > ${tmp}.sql.gz; gunzip -f ${tmp}.sql.gz; chmod 644 ${tmp}.sql; cd ${shq(root)}; sudo -u ${shq(du)} -H wp db import ${tmp}.sql >/dev/null; rm -f ${tmp}.sql`,
      360_000, // outer must exceed the in-script `timeout 300`
    )
    stopDbPoll()
    if (!imp.ok) return fail("db", imp.stderr.trim() || "db pull/import failed")
    onProgress("db", "ok")

    // 6. verify — wp-cli on the dest (HTTP --resolve is the caller's).
    onProgress("verify", "start")
    const ver = await run("verify", dest, `cd ${shq(root)}; sudo -u ${shq(du)} -H wp core is-installed`, 30_000)
    if (!ver.ok) return fail("verify", "wp core is-installed returned false on the dest")
    onProgress("verify", "ok")

    return { ok: true }
  } finally {
    // 7. revoke — drop the pull key (by marker) on source, clean dest temp + staged dump.
    onProgress("revoke", "start")
    await run("revoke", source, `AK=${shq(home)}/.ssh/authorized_keys; [ -f "$AK" ] && sed -i ${shq(`/${MARKER}/d`)} "$AK" && chown ${shq(su)}:${shq(su)} "$AK"; rm -f ${shq(home)}/.clone_db.sql.gz`, 30_000).catch(() => {})
    await run("revoke", dest, `rm -f ${KEY} ${KEY}.pub ${tmp}_auth.json ${tmp}_up.tgz ${tmp}_env ${tmp}.sql.gz ${tmp}.sql`, 30_000).catch(() => {})
    onProgress("revoke", "ok")
  }
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
}

// One round-trip per side: collect labeled wp-cli facts as `key=value` lines.
async function wpFacts(ctx: SudoCtx, root: string, user: string): Promise<Record<string, string>> {
  const script = [
    `cd ${shq(root)} 2>/dev/null || exit 0`,
    `u() { sudo -u ${shq(user)} -H wp "$@" 2>/dev/null; }`,
    `echo "core=$(u core version)"`,
    `echo "posts=$(u post list --post_type=any --format=count)"`,
    `echo "pages=$(u post list --post_type=page --format=count)"`,
    `echo "users=$(u user list --format=count)"`,
    `echo "plugins=$(u plugin list --status=active --format=count)"`,
    `echo "siteurl=$(u option get siteurl)"`,
    `echo "home=$(u option get home)"`,
  ].join("\n")
  const res = await exec(ctx, script, 60_000)
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
    wpFacts(source, srcDir, spec.sourceSiteUser),
    wpFacts(dest, destDir, spec.destSiteUser),
    curlStatus(spec.domain, spec.destIp),
  ])
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

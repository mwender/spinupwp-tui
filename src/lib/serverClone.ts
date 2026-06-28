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
}

// Estimate each source site's payload (webroot bytes + DB bytes) in ONE round trip.
// Webroot via `du -sb /sites/<domain>/files`; DB via `wp db size --size_format=b`
// run as the site user from that dir (wp-cli.yml resolves Bedrock's web/wp path and
// reads .env). Sites whose probe fails are simply omitted from the map.
export async function estimateSourceSiteSizes(
  server: Server,
  sudoUser: string,
  sudoPassword: string,
  sites: SiteSizeInput[],
): Promise<Map<number, number>> {
  if (sites.length === 0) return new Map()
  const lines = sites.map((s) => {
    const root = `/sites/${s.domain}/files`
    return [
      `D=${shq(root)}`,
      `wb=$(du -sb "$D" 2>/dev/null | cut -f1)`,
      `db=$(cd "$D" 2>/dev/null && sudo -u ${shq(s.siteUser)} -H wp db size --size_format=b 2>/dev/null | tr -dc 0-9)`,
      `echo "${s.siteId} \${wb:-0} \${db:-0}"`,
    ].join("; ")
  })
  const res = await sudoExec(server, sudoUser, sudoPassword, lines.join("\n"), 120_000)
  const out = new Map<number, number>()
  if (!res.ok) return out
  for (const line of res.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (!m) continue
    const id = Number(m[1])
    const total = Number(m[2]) + Number(m[3])
    if (total > 0) out.set(id, total)
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
export type CloneStage = "auth" | "files" | "config" | "db" | "verify" | "revoke"
export type CloneProgress = (stage: CloneStage, status: "start" | "ok" | "fail", detail?: string) => void

export interface StandardWpPullSpec {
  domain: string
  sourceSiteUser: string
  destSiteUser: string
  destDbName: string
  destDbUser: string
  destDbPassword: string
}

const CLONE_KEY = "/root/.clone_pull"
const KEY_MARKER = "spinup-clone-pull"

function exec(ctx: SudoCtx, script: string, timeoutMs = 600_000) {
  return sudoExec(ctx.server, ctx.sudoUser, ctx.sudoPassword, script, timeoutMs)
}

// The dest pulls the site's files + DB straight from the source (server-to-server,
// nothing through the orchestrator). Files/DB land owned by the dest site user with a
// wp-config re-stamped to the dest DB. Verifies `wp core is-installed`; the HTTP
// `--resolve` check is the caller's (it knows the dest IP). The granted pull key is
// always revoked (best-effort) before returning.
export async function runStandardWpPull(
  source: SudoCtx,
  dest: SudoCtx,
  spec: StandardWpPullSpec,
  onProgress: CloneProgress = () => {},
): Promise<{ ok: boolean; error?: string }> {
  const srcIp = source.server.ip_address ?? ""
  const root = `/sites/${spec.domain}/files`
  const home = `/sites/${spec.domain}`
  const su = spec.sourceSiteUser
  const du = spec.destSiteUser
  const sshk = `ssh -i ${CLONE_KEY} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10`
  const fail = (stage: CloneStage, msg: string) => {
    onProgress(stage, "fail", msg)
    return { ok: false as const, error: `${stage}: ${msg}` }
  }

  try {
    // 1. auth — ephemeral key on dest, granted onto the source site user.
    onProgress("auth", "start")
    const gen = await exec(dest, `rm -f ${CLONE_KEY} ${CLONE_KEY}.pub; ssh-keygen -t ed25519 -f ${CLONE_KEY} -N "" -C ${KEY_MARKER} >/dev/null 2>&1 && cat ${CLONE_KEY}.pub`, 30_000)
    const pub = gen.stdout.trim()
    if (!gen.ok || !pub.startsWith("ssh-")) return fail("auth", gen.stderr.trim() || "couldn't generate pull key")
    const grant = await exec(
      source,
      `set -e; SSHDIR=${shq(home)}/.ssh; AK=$SSHDIR/authorized_keys; install -d -m 700 -o ${shq(su)} -g ${shq(su)} "$SSHDIR"; touch "$AK"; chown ${shq(su)}:${shq(su)} "$AK"; chmod 600 "$AK"; grep -qxF ${shq(pub)} "$AK" || echo ${shq(pub)} >> "$AK"`,
      30_000,
    )
    if (!grant.ok) return fail("auth", grant.stderr.trim() || "couldn't grant pull key on source")
    onProgress("auth", "ok")

    // 2. files — tar-over-ssh pull → extract → chown.
    onProgress("files", "start")
    const files = await exec(
      dest,
      `set -e; timeout -k 5 900 ${sshk} ${shq(su)}@${srcIp} "tar -C ${shq(root)} --warning=no-file-changed -czf - --exclude=wp-content/cache ." </dev/null > /tmp/clone_${spec.domain}.tgz; tar -C ${shq(root)} -xzf /tmp/clone_${spec.domain}.tgz; rm -f /tmp/clone_${spec.domain}.tgz; chown -R ${shq(du)}:${shq(du)} ${shq(root)}; test -f ${shq(root)}/wp-config.php`,
      900_000,
    )
    if (!files.ok) return fail("files", files.stderr.trim() || "file pull failed")
    onProgress("files", "ok")

    // 3. config — re-stamp DB creds to the dest's.
    onProgress("config", "start")
    const cfg = await exec(
      dest,
      `set -e; cd ${shq(root)}; sudo -u ${shq(du)} -H wp config set DB_NAME ${shq(spec.destDbName)} --type=constant >/dev/null; sudo -u ${shq(du)} -H wp config set DB_USER ${shq(spec.destDbUser)} --type=constant >/dev/null; sudo -u ${shq(du)} -H wp config set DB_PASSWORD ${shq(spec.destDbPassword)} --type=constant >/dev/null; sudo -u ${shq(du)} -H wp db check >/dev/null 2>&1`,
      60_000,
    )
    if (!cfg.ok) return fail("config", cfg.stderr.trim() || "re-stamp / db check failed")
    onProgress("config", "ok")

    // 4. db — stage on source (clean stream → file), pull, import.
    onProgress("db", "start")
    const dump = await exec(
      source,
      `sudo -u ${shq(su)} -H bash -c "cd ${shq(root)} && wp --skip-plugins --skip-themes db export ${shq(home)}/.clone_db.sql 2>/dev/null && gzip -f ${shq(home)}/.clone_db.sql"`,
      300_000,
    )
    if (!dump.ok) return fail("db", dump.stderr.trim() || "source db export failed")
    const imp = await exec(
      dest,
      `set -e; timeout -k 5 300 ${sshk} ${shq(su)}@${srcIp} "cat ${shq(home)}/.clone_db.sql.gz" </dev/null > /tmp/clone_${spec.domain}.sql.gz; gunzip -f /tmp/clone_${spec.domain}.sql.gz; chmod 644 /tmp/clone_${spec.domain}.sql; cd ${shq(root)}; sudo -u ${shq(du)} -H wp db import /tmp/clone_${spec.domain}.sql >/dev/null; rm -f /tmp/clone_${spec.domain}.sql`,
      300_000,
    )
    if (!imp.ok) return fail("db", imp.stderr.trim() || "db pull/import failed")
    onProgress("db", "ok")

    // 5. verify — wp-cli on the dest (HTTP --resolve is the caller's).
    onProgress("verify", "start")
    const ver = await exec(dest, `cd ${shq(root)}; sudo -u ${shq(du)} -H wp core is-installed`, 30_000)
    if (!ver.ok) return fail("verify", "wp core is-installed returned false on the dest")
    onProgress("verify", "ok")

    return { ok: true }
  } finally {
    // 6. revoke — always: drop the pull key (by marker) on source, remove the
    // ephemeral key + staged dump on dest. Best-effort.
    onProgress("revoke", "start")
    // sed (not grep -v): grep returns exit 1 when it filters out the only line, which
    // would skip the rewrite and leave the key behind — exactly the case where the
    // source site user has no other keys.
    await exec(source, `AK=${shq(home)}/.ssh/authorized_keys; [ -f "$AK" ] && sed -i ${shq(`/${KEY_MARKER}/d`)} "$AK" && chown ${shq(su)}:${shq(su)} "$AK"; rm -f ${shq(home)}/.clone_db.sql.gz`, 30_000).catch(() => {})
    await exec(dest, `rm -f ${CLONE_KEY} ${CLONE_KEY}.pub /tmp/clone_${spec.domain}.tgz /tmp/clone_${spec.domain}.sql.gz /tmp/clone_${spec.domain}.sql`, 30_000).catch(() => {})
    onProgress("revoke", "ok")
  }
}

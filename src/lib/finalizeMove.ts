// Final database sync for an already-copied SpinupWP server move.
//
// This deliberately stops short of provider-specific IP reassignment. It freezes
// the source site, exports a clean DB file there, imports it into the existing
// destination site's configured database, verifies the destination, and leaves
// cutover as a provider-neutral DNS/manual step in the UI.

import type { Server } from "../api/types.ts"
import { detectWpDirScript, sudoExec, type SudoCtx, type SudoResult } from "./serverClone.ts"
import { normalizeDomain } from "./dns.ts"
import type { Site } from "../api/types.ts"

// A moved site can have a different primary hostname on its destination (most
// often the apex versus `www` form). SpinupWP also records aliases separately
// in `additional_domains`, so use every configured hostname when pairing the
// source's primary domain with its destination site. Do not guess when two
// destination sites claim the same canonical hostname.
export function matchFinalizeDestinationSite(sourceDomain: string, destinationSites: Site[]): Site | undefined {
  const target = normalizeDomain(sourceDomain)
  if (!target) return undefined
  const matches = destinationSites.filter((site) =>
    [site.domain, ...(site.additional_domains ?? []).map((domain) => domain.domain)].some((domain) => normalizeDomain(domain) === target),
  )
  return matches.length === 1 ? matches[0] : undefined
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function exec(ctx: SudoCtx, script: string, timeoutMs = 600_000): Promise<SudoResult> {
  return sudoExec(ctx.server, ctx.sudoUser, ctx.sudoPassword, script, timeoutMs)
}

function siteFiles(domain: string): string {
  return `/sites/${domain}/files`
}

function siteHome(domain: string): string {
  return `/sites/${domain}`
}

function publicFolderArg(publicFolder?: string | null): string | undefined {
  return publicFolder ?? undefined
}

export type FinalizeStage = "detect" | "auth" | "maintenance" | "export" | "transfer" | "import" | "verify" | "php" | "cleanup"
export type FinalizeProgress = (stage: FinalizeStage, status: "start" | "ok" | "fail", detail?: string) => void
export interface FinalizeExecRecord {
  domain: string
  stage: FinalizeStage
  host: string
  ok: boolean
  code: number
  ms: number
  script: string
  stdout: string
  stderr: string
}
export type FinalizeExecLog = (e: FinalizeExecRecord) => void

export interface FinalizeSiteSpec {
  domain: string
  sourceSiteUser: string
  destSiteUser: string
  sourcePublicFolder?: string | null
  destPublicFolder?: string | null
}

export interface FinalizeSiteResult {
  ok: boolean
  error?: string
  sourceWpDir?: string
  destWpDir?: string
  destDbName?: string
}

export interface DatabaseInventory {
  databases: string[]
  active: string[]
  stale: string[]
}

function wpCwdScript(domain: string, publicFolder?: string | null): string {
  const root = siteFiles(domain)
  return [
    detectWpDirScript(root, publicFolderArg(publicFolder)),
    // A project's wp-cli.yml can point wp-cli at its real install and config
    // (including a config one level above web/wp), so run from its directory.
    `[ -f "$D/wp-cli.yml" ] && W="$D"`,
    `[ -n "$W" ] || { echo "no WordPress install found under $D" >&2; exit 64; }`,
  ].join("; ")
}

function envValueScript(name: string, file = ".env"): string {
  // Use octal quotes in the awk regex: the generated program is single-quoted
  // by the shell, so embedding a literal apostrophe would break the script.
  return `awk -F= '$1==${JSON.stringify(name)} { v=$0; sub(/^[^=]*=/, "", v); gsub(/^[\\042\\047]|[\\042\\047]$/, "", v); print v; exit }' ${file} 2>/dev/null`
}

export function dbNameScript(siteUser: string): string {
  // Bedrock commonly keeps .env at files/, while the detected WordPress
  // directory is files/web/wp. Check both before falling back to wp-cli.
  return `DB=$(${envValueScript("DB_NAME")}); [ -n "$DB" ] || DB=$(${envValueScript("DB_NAME", '"$D/.env"')}); [ -n "$DB" ] || DB=$(sudo -u ${shq(siteUser)} -H wp config get DB_NAME 2>/dev/null || true)`
}

export async function runFinalizeDbSync(
  source: SudoCtx,
  dest: SudoCtx,
  spec: FinalizeSiteSpec,
  onProgress: FinalizeProgress = () => {},
  onExec?: FinalizeExecLog,
): Promise<FinalizeSiteResult> {
  const srcIp = source.server.ip_address ?? ""
  const home = siteHome(spec.domain)
  const su = spec.sourceSiteUser
  const du = spec.destSiteUser
  const tmpBase = `/tmp/finalize_${spec.domain.replace(/[^A-Za-z0-9_.-]/g, "_")}_${Date.now()}`
  const srcDump = `${home}/.finalize_db.sql`
  const srcGz = `${srcDump}.gz`
  const destGz = `${tmpBase}.sql.gz`
  const destSql = `${tmpBase}.sql`
  const key = `/root/.finalize_pull_${spec.domain}`
  const marker = `spinup-finalize-pull-${spec.domain}`

  const fail = (stage: FinalizeStage, msg: string): FinalizeSiteResult => {
    onProgress(stage, "fail", msg)
    return { ok: false, error: `${stage}: ${msg}` }
  }
  const run = async (stage: FinalizeStage, ctx: SudoCtx, script: string, timeoutMs?: number) => {
    const t0 = Date.now()
    const r = await exec(ctx, script, timeoutMs)
    onExec?.({ domain: spec.domain, stage, host: ctx.server.name, ok: r.ok, code: r.code, ms: Date.now() - t0, script, stdout: r.stdout, stderr: r.stderr })
    return r
  }

  let sourceWpDir = ""
  let destWpDir = ""
  let destDbName = ""
  try {
    onProgress("detect", "start")
    const srcDet = await run("detect", source, `${wpCwdScript(spec.domain, spec.sourcePublicFolder)}; echo "WPDIR:$W"`, 30_000)
    sourceWpDir = (srcDet.stdout.match(/^WPDIR:(.*)$/m)?.[1] ?? "").trim()
    if (!srcDet.ok || !sourceWpDir) return fail("detect", srcDet.stderr.trim() || "couldn't find the source WordPress install")

    const dstDet = await run(
      "detect",
      dest,
      `${wpCwdScript(spec.domain, spec.destPublicFolder)}; cd "$W"; ${dbNameScript(du)}; sudo -u ${shq(du)} -H wp db check >/dev/null; echo "WPDIR:$W"; echo "DBNAME:$DB"`,
      30_000,
    )
    destWpDir = (dstDet.stdout.match(/^WPDIR:(.*)$/m)?.[1] ?? "").trim()
    destDbName = (dstDet.stdout.match(/^DBNAME:(.*)$/m)?.[1] ?? "").trim()
    if (!dstDet.ok || !destWpDir) return fail("detect", dstDet.stderr.trim() || "couldn't find the destination WordPress install")
    onProgress("detect", "ok", destDbName || "destination DB connection verified")

    onProgress("auth", "start")
    const gen = await run("auth", dest, `rm -f ${shq(key)} ${shq(`${key}.pub`)}; ssh-keygen -t ed25519 -f ${shq(key)} -N "" -C ${shq(marker)} >/dev/null 2>&1 && cat ${shq(`${key}.pub`)}`, 30_000)
    const pub = gen.stdout.trim()
    if (!gen.ok || !pub.startsWith("ssh-")) return fail("auth", gen.stderr.trim() || "couldn't generate the destination pull key")
    const grant = await run(
      "auth",
      source,
      `set -e; SSHDIR=${shq(home)}/.ssh; AK="$SSHDIR/authorized_keys"; install -d -m 700 -o ${shq(su)} -g ${shq(su)} "$SSHDIR"; touch "$AK"; chown ${shq(su)}:${shq(su)} "$AK"; chmod 600 "$AK"; grep -qxF ${shq(pub)} "$AK" || echo ${shq(pub)} >> "$AK"`,
      30_000,
    )
    if (!grant.ok) return fail("auth", grant.stderr.trim() || "couldn't grant the destination pull key on source")
    onProgress("auth", "ok")

    onProgress("maintenance", "start")
    const maint = await run("maintenance", source, `cd ${shq(sourceWpDir)}; sudo -u ${shq(su)} -H wp maintenance-mode activate >/dev/null`, 30_000)
    if (!maint.ok) return fail("maintenance", maint.stderr.trim() || "couldn't activate source maintenance mode")
    onProgress("maintenance", "ok")

    onProgress("export", "start")
    const dump = await run(
      "export",
      source,
      `set -e; rm -f ${shq(srcDump)} ${shq(srcGz)}; cd ${shq(sourceWpDir)}; sudo -u ${shq(su)} -H wp --skip-plugins --skip-themes db export ${shq(srcDump)} --single-transaction >/dev/null; gzip -f ${shq(srcDump)}; stat -c %s ${shq(srcGz)}`,
      900_000,
    )
    if (!dump.ok) return fail("export", dump.stderr.trim() || "source db export failed")
    onProgress("export", "ok", dump.stdout.trim().split("\n").pop())

    onProgress("transfer", "start")
    const pull = await run(
      "transfer",
      dest,
      `set -e; ssh -i ${shq(key)} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 ${shq(su)}@${shq(srcIp)} "cat ${shq(srcGz)}" </dev/null > ${shq(destGz)}; test -s ${shq(destGz)}`,
      360_000,
    )
    if (!pull.ok) return fail("transfer", pull.stderr.trim() || "destination couldn't pull the source dump")
    onProgress("transfer", "ok")

    onProgress("import", "start")
    const imp = await run(
      "import",
      dest,
      [
        `set -e`,
        `gunzip -f ${shq(destGz)}`,
        `chown ${shq(du)}:${shq(du)} ${shq(destSql)}`,
        `chmod 600 ${shq(destSql)}`,
        `cd ${shq(destWpDir)}`,
        `sudo -u ${shq(du)} -H wp db check >/dev/null`,
        `sudo -u ${shq(du)} -H wp db import ${shq(destSql)} >/dev/null`,
        `sudo -u ${shq(du)} -H wp cache flush >/dev/null 2>&1 || true`,
        `sudo -u ${shq(du)} -H wp maintenance-mode deactivate >/dev/null 2>&1 || true`,
        `rm -f ${shq(destSql)}`,
      ].join("; "),
      900_000,
    )
    if (!imp.ok) return fail("import", imp.stderr.trim() || "destination db import failed")
    onProgress("import", "ok")

    onProgress("verify", "start")
    const ver = await run("verify", dest, `cd ${shq(destWpDir)}; sudo -u ${shq(du)} -H wp db check >/dev/null; sudo -u ${shq(du)} -H wp core is-installed`, 45_000)
    if (!ver.ok) return fail("verify", ver.stderr.trim() || "destination verification failed")
    onProgress("verify", "ok")

    onProgress("cleanup", "start")
    await run("cleanup", source, `rm -f ${shq(srcGz)}`, 30_000).catch(() => {})
    await run("cleanup", dest, `rm -f ${shq(destGz)} ${shq(destSql)}`, 30_000).catch(() => {})
    onProgress("cleanup", "ok")

    return { ok: true, sourceWpDir, destWpDir, destDbName }
  } catch (err) {
    return fail("cleanup", (err as Error).message)
  } finally {
    await exec(source, `AK=${shq(home)}/.ssh/authorized_keys; [ -f "$AK" ] && sed -i ${shq(`/${marker}/d`)} "$AK" && chown ${shq(su)}:${shq(su)} "$AK"; rm -f ${shq(srcGz)}`, 30_000).catch(() => {})
    await exec(dest, `rm -f ${shq(key)} ${shq(`${key}.pub`)} ${shq(destGz)} ${shq(destSql)}`, 30_000).catch(() => {})
  }
}

export async function rollbackSourceMaintenance(source: SudoCtx, spec: FinalizeSiteSpec): Promise<void> {
  const det = await exec(source, `${wpCwdScript(spec.domain, spec.sourcePublicFolder)}; echo "WPDIR:$W"`, 30_000)
  const wpDir = (det.stdout.match(/^WPDIR:(.*)$/m)?.[1] ?? "").trim()
  if (!det.ok || !wpDir) return
  await exec(source, `cd ${shq(wpDir)}; sudo -u ${shq(spec.sourceSiteUser)} -H wp maintenance-mode deactivate >/dev/null 2>&1 || true`, 30_000)
}

export async function inventoryDatabases(server: Server, sudoUser: string, sudoPassword: string, activeDatabases: string[]): Promise<DatabaseInventory> {
  const res = await sudoExec(server, sudoUser, sudoPassword, `mysql -NBe "SHOW DATABASES"`, 30_000)
  const databases = res.ok ? res.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : []
  const system = new Set(["information_schema", "mysql", "performance_schema", "sys"])
  const active = Array.from(new Set(activeDatabases.filter(Boolean))).sort()
  const activeSet = new Set(active)
  const stale = databases.filter((db) => !system.has(db) && !activeSet.has(db)).sort()
  return { databases, active, stale }
}

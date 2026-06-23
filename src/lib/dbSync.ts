// Pull a production database down into the local working copy.
//
// Builds on the DB-backup pipeline: export prod (read-only), download the gzip,
// then IMPORT it into the LOCAL WordPress DB and rewrite URLs so the local copy
// mirrors production. This is destructive on LOCAL (it overwrites the local DB),
// but never writes to production — so we back up the local DB first.
//
// Works for Standard WP and Bedrock without configuration: local `wp` auto-
// discovers the install from the linked project dir, and the local URL / table
// prefix are detected from the link, the project .env, or wp-config.php. It even
// runs an existing bin/sync.d/post-import.sh hook with the same WEB_DIR /
// SYNC_REMOTE_HOST / SYNC_LOCAL_HOST env contract as the sync-prod-to-local
// script, so per-project tweaks (Elementor URL swaps, plugin toggles) carry over.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { join, dirname } from "node:path"
import type { Server, Site } from "../api/types.ts"
import { expandPath, findProjectRoot, type LocalLink } from "./local.ts"
import { remoteDocRoot, backupBaseName, SSH_OPTS, sshPort, scpPort, runProcess, meaningfulError } from "./dbBackup.ts"

// Read a KEY=value from a dotenv file, tolerating surrounding quotes. null if absent.
function readEnvVar(envPath: string, key: string): string | null {
  try {
    const m = readFileSync(envPath, "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, "m"))
    if (!m) return null
    return m[1].trim().replace(/^['"]|['"]$/g, "") || null
  } catch {
    return null
  }
}

// Read $table_prefix from a wp-config.php (Standard WP). null if absent.
function readWpConfigPrefix(configPath: string): string | null {
  try {
    const m = readFileSync(configPath, "utf8").match(/\$table_prefix\s*=\s*['"]([^'"]+)['"]/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

// Bare host of a URL (drops scheme, path, trailing slash).
function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "").trim()
}

// An INERT starter post-import hook. Every real command is commented out and the
// only live line is an echo, so scaffolding-then-pulling can't surprise anyone —
// the user uncomments what they want deliberately. The comments document the env
// contract (WEB_DIR / SYNC_REMOTE_HOST / SYNC_LOCAL_HOST, see runDbSync) and the
// real-world tweaks (Elementor URL swaps, plugin toggles) the hook exists for.
const SAMPLE_HOOK = `#!/usr/bin/env bash
set -euo pipefail
# Runs after Spinup pulls production → local (DB imported, URLs rewritten).
# Spinup exports these for you:
#   WEB_DIR           local project root (this script starts here)
#   SYNC_REMOTE_HOST  production host, e.g. example.com
#   SYNC_LOCAL_HOST   local host,      e.g. example.test
cd "$WEB_DIR"

# --- Examples — uncomment what your project needs ----------------------
# Elementor stores absolute URLs in serialized data; rewrite + reflush:
# wp elementor replace_urls "https://$SYNC_REMOTE_HOST" "https://$SYNC_LOCAL_HOST"
# wp elementor flush_css
#
# Turn off prod-only plugins locally (keep non-fatal with || true):
# wp plugin deactivate spinupwp limit-login-attempts-reloaded || true
# wp plugin activate localdev-switcher || true
# -----------------------------------------------------------------------

echo "post-import hook ran (nothing to do yet — edit bin/sync.d/post-import.sh)"
`

// Scaffold the inert sample hook at <localRoot>/bin/sync.d/post-import.sh and
// mark it executable. Returns the absolute path. Never overwrites an existing
// file (callers only offer this when no hook is present). Throws on write error.
export function writeSampleHook(localRoot: string): string {
  const path = join(localRoot, "bin", "sync.d", "post-import.sh")
  if (existsSync(path)) return path
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, SAMPLE_HOOK)
  chmodSync(path, 0o755)
  return path
}

export interface DbSyncPlan {
  user: string
  host: string
  port: number | null
  docroot: string
  remoteGz: string // $HOME-relative gz produced on the remote
  localRoot: string // where local `wp` runs (findProjectRoot of the link)
  sqlDir: string // localRoot/sql
  downloadPath: string // sqlDir/<base>.sql.gz — the prod dump, kept as a backup
  localBackupPath: string // sqlDir/local_<ts>.sql.gz — pre-import safety dump
  remoteOrigin: string // https://prod-domain (rewritten from)
  localOrigin: string // local URL as entered (rewritten to)
  remoteHost: string // bare prod host (hook env)
  localHost: string // bare local host (hook env)
  hookPath: string | null // bin/sync.d/post-import.sh, if present
  prefixWarning: string | null // set when remote/local table prefixes differ
}

export type SyncPlanResult = { ok: true; plan: DbSyncPlan } | { ok: false; error: string }

export function planDbSync(
  site: Site,
  server: Server | undefined,
  sshUser: string | null,
  link: LocalLink | undefined,
  now: Date,
): SyncPlanResult {
  const host = server?.ip_address
  const user = site.site_user ?? sshUser
  if (!host || !user) return { ok: false, error: "Missing site user or server IP — can't reach the site." }
  if (!link) return { ok: false, error: "Not linked — press L to link a local copy first." }
  const dir = expandPath(link.path)
  if (!existsSync(dir)) return { ok: false, error: "Local path is missing — press L to fix the link." }

  const localRoot = findProjectRoot(dir)
  const envPath = join(localRoot, ".env")

  // Local origin (URL rewrite target): the linked localUrl wins; fall back to the
  // project .env WP_HOME (Bedrock). Required — without it we'd leave prod URLs.
  const localUrlRaw = link.localUrl?.trim() || readEnvVar(envPath, "WP_HOME") || ""
  if (!localUrlRaw) return { ok: false, error: "No local URL — press L to set one (needed to rewrite URLs)." }
  const localOrigin = localUrlRaw.replace(/\/+$/, "")
  const localHost = hostOf(localOrigin)
  const remoteHost = site.domain
  const remoteOrigin = `${site.https?.enabled ? "https" : "http"}://${remoteHost}`

  // Prefix sanity: a remote↔local table-prefix mismatch makes the imported DB
  // unusable by local wp (search-replace would target the wrong tables). Warn.
  const remotePrefix = site.database?.table_prefix ?? null
  const localPrefix = readEnvVar(envPath, "DB_PREFIX") ?? readWpConfigPrefix(join(localRoot, "wp-config.php"))
  const prefixWarning =
    remotePrefix && localPrefix && remotePrefix !== localPrefix
      ? `Table prefix differs (remote "${remotePrefix}" vs local "${localPrefix}") — the import may not line up.`
      : null

  const sqlDir = join(localRoot, "sql")
  const base = backupBaseName(site.domain, now)
  const stamp = base.slice(base.indexOf("_") + 1) // the date_time part
  return {
    ok: true,
    plan: {
      user,
      host,
      port: server?.ssh_port ?? null,
      docroot: remoteDocRoot(site.domain, site.public_folder),
      remoteGz: `${base}.sql.gz`,
      localRoot,
      sqlDir,
      downloadPath: join(sqlDir, `${base}.sql.gz`),
      localBackupPath: join(sqlDir, `local_${stamp}.sql.gz`),
      remoteOrigin,
      localOrigin,
      remoteHost,
      localHost,
      hookPath: existsSync(join(localRoot, "bin", "sync.d", "post-import.sh"))
        ? join(localRoot, "bin", "sync.d", "post-import.sh")
        : null,
      prefixWarning,
    },
  }
}

export type DbSyncStage = "local-backup" | "export" | "download" | "import" | "replace" | "hook" | "done" | "error"

export interface DbSyncProgress {
  stage: DbSyncStage
  domain: string
  downloadPath?: string
  localBackupPath?: string
  ranHook?: boolean
  error?: string
  failedStage?: DbSyncStage // which step broke, so the UI can mark it ✕
}

export function isDbSyncInFlight(p: DbSyncProgress | undefined): boolean {
  return p != null && p.stage !== "done" && p.stage !== "error"
}

// Run the full pull, reporting each stage. Resolves with the terminal progress
// (done | error). Never throws. Read-only on production; destructive on local.
export async function runDbSync(plan: DbSyncPlan, domain: string, onProgress: (p: DbSyncProgress) => void): Promise<DbSyncProgress> {
  const target = `${plan.user}@${plan.host}`
  const fail = (error: string, failedStage: DbSyncStage = "local-backup"): DbSyncProgress => {
    const p: DbSyncProgress = { stage: "error", domain, error, failedStage }
    onProgress(p)
    return p
  }
  // Prefix the surfaced error with the failing stage so it's self-locating
  // (e.g. "Local DB backup failed — mysqldump: …" rather than a bare driver line).
  const stageFail = (label: string, stderr: string, fallback: string, failedStage: DbSyncStage) =>
    fail(`${label} — ${meaningfulError(stderr, fallback)}`, failedStage)
  // Run local `wp` through a login shell so the user's PATH (composer/phar) resolves.
  const wp = (cmd: string, timeoutMs: number, env?: Record<string, string>) => runProcess(["bash", "-lc", cmd], timeoutMs, plan.localRoot, env)

  // 0) wp-cli must exist locally — fail with a clear message rather than cryptically.
  if ((await wp("command -v wp", 15_000)).code !== 0) return fail("WP-CLI not found locally — install wp-cli to sync.", "local-backup")

  // 1) Safety: back up the LOCAL DB before we overwrite it (file, then gzip).
  onProgress({ stage: "local-backup", domain })
  try {
    mkdirSync(plan.sqlDir, { recursive: true })
  } catch {
    /* best-effort */
  }
  const localSql = plan.localBackupPath.replace(/\.gz$/, "")
  const lb = await wp(`wp db export "${localSql}" >/dev/null && gzip -f "${localSql}"`, 300_000)
  if (lb.code !== 0) return stageFail("Local DB backup failed", lb.stderr, "couldn't export the local database.", "local-backup")

  // 2) Export prod + download the gzip (same remote pipeline as the backup).
  onProgress({ stage: "export", domain })
  const sql = plan.remoteGz.replace(/\.gz$/, "")
  const remoteScript =
    `set -e; cd '${plan.docroot}'; wp db export "$HOME/${sql}" --single-transaction >/dev/null; gzip -f "$HOME/${sql}"`
  const exp = await runProcess(["ssh", ...SSH_OPTS, ...sshPort(plan.port), target, remoteScript], 300_000)
  if (exp.code !== 0) return stageFail("Remote export failed", exp.stderr, `ssh exit ${exp.code}.`, "export")

  onProgress({ stage: "download", domain })
  const dl = await runProcess(["scp", ...SSH_OPTS, ...scpPort(plan.port), `${target}:${plan.remoteGz}`, plan.downloadPath], 300_000)
  if (dl.code !== 0) {
    void runProcess(["ssh", ...SSH_OPTS, ...sshPort(plan.port), target, `rm -f "$HOME/${plan.remoteGz}"`], 30_000)
    return stageFail("Download failed", dl.stderr, `scp exit ${dl.code}.`, "download")
  }
  void runProcess(["ssh", ...SSH_OPTS, ...sshPort(plan.port), target, `rm -f "$HOME/${plan.remoteGz}"`], 30_000)

  // 3) Import into local: stream gunzip → wp db cli (no temp extract).
  onProgress({ stage: "import", domain })
  const imp = await wp(`gunzip -c "${plan.downloadPath}" | wp db cli`, 600_000)
  if (imp.code !== 0) return stageFail("Local import failed", imp.stderr, "wp db cli error.", "import")

  // 4) Rewrite production URLs → local URLs.
  onProgress({ stage: "replace", domain })
  const sr = await wp(`wp search-replace "${plan.remoteOrigin}" "${plan.localOrigin}" --skip-columns=guid --format=count`, 300_000)
  if (sr.code !== 0) return stageFail("URL search-replace failed", sr.stderr, "wp search-replace error.", "replace")

  // 5) Optional per-project post-import hook (Elementor swaps, plugin toggles, …).
  let ranHook = false
  if (plan.hookPath) {
    onProgress({ stage: "hook", domain })
    const env = { ...process.env, WEB_DIR: plan.localRoot, SYNC_REMOTE_HOST: plan.remoteHost, SYNC_LOCAL_HOST: plan.localHost } as Record<string, string>
    const hk = await runProcess(["bash", plan.hookPath], 300_000, plan.localRoot, env)
    if (hk.code !== 0) return stageFail("Post-import hook failed", hk.stderr, "hook script error.", "hook")
    ranHook = true
  }

  const done: DbSyncProgress = { stage: "done", domain, downloadPath: plan.downloadPath, localBackupPath: plan.localBackupPath, ranHook }
  onProgress(done)
  return done
}

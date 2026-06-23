// Download a production database backup over SSH.
//
// Mirrors the proven sync-prod-to-local pattern: export to a stage file OUTSIDE
// the public webroot (in $HOME), gzip it remotely, scp it down into the linked
// project's `sql/` dir, then remove the remote copy.
//
// We deliberately do NOT stream `wp db export -` to stdout: plugins print to
// stdout during WP bootstrap (e.g. GiveWP deprecation notices), which would
// corrupt the dump. `wp db export <file>` writes pure SQL regardless of that
// noise. SSH is non-interactive (BatchMode) — SpinupWP sites are key-only, so
// this works headlessly from the user's agent; a missing key fails fast.

import { existsSync, mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Server, Site } from "../api/types.ts"
import { expandPath, type LocalLink } from "./local.ts"

export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"]

// ssh uses -p for a non-default port, scp uses -P.
export const sshPort = (port: number | null | undefined) => (port && port !== 22 ? ["-p", String(port)] : [])
export const scpPort = (port: number | null | undefined) => (port && port !== 22 ? ["-P", String(port)] : [])

// Derive a SpinupWP site's absolute remote document root. SpinupWP serves each
// site from `/sites/{domain}/files{public_folder}`; the API's `public_folder` is
// only the suffix (e.g. "/public/" for standard WP, "/web/" for Bedrock), so we
// join it onto the fixed base. wp-cli finds the install from this cwd.
export function remoteDocRoot(domain: string, publicFolder: string | null): string {
  const suffix = (publicFolder ?? "public").replace(/^\/+|\/+$/g, "") // strip surrounding slashes
  const base = `/sites/${domain}/files`
  return suffix ? `${base}/${suffix}` : base
}

const p2 = (n: number) => String(n).padStart(2, "0")

// Timestamped backup base name, e.g. "hoperedefined.org_2026-06-22_1113".
export function backupBaseName(domain: string, now: Date): string {
  const d = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
  const t = `${p2(now.getHours())}${p2(now.getMinutes())}`
  return `${domain}_${d}_${t}`
}

export interface DbBackupPlan {
  user: string
  host: string
  port: number | null
  docroot: string
  // The gzipped stage file, named relative to $HOME so scp can address it
  // directly (e.g. "hoperedefined.org_2026-06-22_1113.sql.gz").
  remoteGz: string
  destDir: string // local <projectRoot>/sql
  destPath: string // local absolute path of the downloaded .sql.gz
}

export type PlanResult = { ok: true; plan: DbBackupPlan } | { ok: false; error: string }

// Resolve everything needed to run a backup, or a human-readable reason it can't
// run. The destination lives in the linked working copy, so an unlinked (or
// missing) local path is a hard stop.
export function planDbBackup(
  site: Site,
  server: Server | undefined,
  sshUser: string | null,
  link: LocalLink | undefined,
  now: Date,
): PlanResult {
  const host = server?.ip_address
  const user = site.site_user ?? sshUser
  if (!host || !user) return { ok: false, error: "Missing site user or server IP — can't reach the site." }
  if (!link) return { ok: false, error: "Not linked — press L to link a local copy first." }
  const dir = expandPath(link.path)
  if (!existsSync(dir)) return { ok: false, error: "Local path is missing — press L to fix the link." }

  // Drop the backup in the folder the user linked (where `t` opens a terminal),
  // under a sql/ subdir — same convention as the sync-prod-to-local script.
  const destDir = join(dir, "sql")
  const remoteGz = `${backupBaseName(site.domain, now)}.sql.gz`
  return {
    ok: true,
    plan: {
      user,
      host,
      port: server?.ssh_port ?? null,
      docroot: remoteDocRoot(site.domain, site.public_folder),
      remoteGz,
      destDir,
      destPath: join(destDir, remoteGz),
    },
  }
}

export type DbBackupStage = "export" | "download" | "cleanup" | "done" | "error"

export interface DbBackupProgress {
  stage: DbBackupStage
  domain: string
  destPath?: string
  bytes?: number
  error?: string
  failedStage?: DbBackupStage // which step broke, so the UI can mark it ✕
}

export function isDbBackupInFlight(p: DbBackupProgress | undefined): boolean {
  return p != null && p.stage !== "done" && p.stage !== "error"
}

// Run a child process to completion, capturing output with a hard timeout. An
// optional cwd lets callers run local `wp` in a project directory.
export async function runProcess(
  cmd: string[],
  timeoutMs: number,
  cwd?: string,
  env?: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd, env })
  } catch (err) {
    return { code: -1, stderr: `Failed to launch ${cmd[0]}: ${(err as Error).message}` }
  }
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, timeoutMs)
  const code = await proc.exited
  clearTimeout(timer)
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
  return { code, stderr }
}

// Pick a meaningful error line out of ssh/wp stderr, skipping the deprecation /
// warning noise WordPress plugins emit during bootstrap.
export function meaningfulError(stderr: string, fallback: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^(PHP\s+)?(Deprecated|Warning|Notice):/i.test(l))
  return lines[lines.length - 1] || fallback
}

// Run the full backup, reporting each stage through `onProgress`. Resolves with
// the terminal progress (done | error). Never throws.
export async function runDbBackup(
  plan: DbBackupPlan,
  domain: string,
  onProgress: (p: DbBackupProgress) => void,
): Promise<DbBackupProgress> {
  const target = `${plan.user}@${plan.host}`
  const fail = (error: string, failedStage: DbBackupStage): DbBackupProgress => {
    const p: DbBackupProgress = { stage: "error", domain, error, failedStage }
    onProgress(p)
    return p
  }

  // 1) Export on the remote into a $HOME stage file (outside the webroot) and
  //    gzip it. `wp db export <file>` writes pure SQL even when plugins print to
  //    stdout; --single-transaction avoids locking the live DB during the dump.
  onProgress({ stage: "export", domain })
  const sql = plan.remoteGz.replace(/\.gz$/, "") // <base>.sql
  const remoteScript =
    `set -e; cd '${plan.docroot}'; ` +
    `wp db export "$HOME/${sql}" --single-transaction >/dev/null; ` +
    `gzip -f "$HOME/${sql}"`
  const exp = await runProcess(["ssh", ...SSH_OPTS, ...sshPort(plan.port), target, remoteScript], 300_000)
  if (exp.code !== 0) return fail(`Remote export failed — ${meaningfulError(exp.stderr, `ssh exit ${exp.code}.`)}`, "export")

  // 2) Download the gzip into the project's sql/ dir.
  onProgress({ stage: "download", domain })
  try {
    mkdirSync(plan.destDir, { recursive: true })
  } catch {
    /* best-effort; scp surfaces a real write failure */
  }
  const dl = await runProcess(["scp", ...SSH_OPTS, ...scpPort(plan.port), `${target}:${plan.remoteGz}`, plan.destPath], 300_000)
  if (dl.code !== 0) {
    // Still try to remove the remote stage file so it doesn't linger.
    void runProcess(["ssh", ...SSH_OPTS, ...sshPort(plan.port), target, `rm -f "$HOME/${plan.remoteGz}"`], 30_000)
    return fail(`Download failed — ${meaningfulError(dl.stderr, `scp exit ${dl.code}.`)}`, "download")
  }

  // 3) Remove the remote stage file.
  onProgress({ stage: "cleanup", domain })
  await runProcess(["ssh", ...SSH_OPTS, ...sshPort(plan.port), target, `rm -f "$HOME/${plan.remoteGz}"`], 30_000)

  let bytes: number | undefined
  try {
    bytes = statSync(plan.destPath).size
  } catch {
    /* file exists per scp exit 0; size is cosmetic */
  }
  const done: DbBackupProgress = { stage: "done", domain, destPath: plan.destPath, bytes }
  onProgress(done)
  return done
}

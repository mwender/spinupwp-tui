// `spinuptui pull files` / `spinuptui pull db` — the two local-working-copy
// engines, driven non-interactively.
//
// Same engines the TUI drives (lib/localSetup.ts and lib/dbSync.ts), same
// domain resolution as `ssh`/`ssh-exec` (lib/cliSsh.ts's resolveSiteByDomain),
// so behavior can't drift between the two front ends. Nothing here reimplements
// a step; this file is argument resolution, gating, and result shaping.
//
// Output contract, matching the other subcommands: the returned object is the
// machine-readable result (one JSON object on stdout under --json, exit code
// mirrors `ok`). Progress goes to the caller's `onStage` — stderr, always,
// human-readable — so a person watching a ten-minute rsync can see it isn't
// hung and an agent still has the trail when something fails.
//
// `pull files` is read-only on production. `pull db` OVERWRITES the local
// database, so it's gated twice: the `localSync` config opt-in (same gate the
// TUI enforces) and an explicit `--yes` on the invocation. Both are checked
// before any network call, so a typo'd domain in a script fails on the gate.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { configPath, type AppConfig } from "../config.ts"
import type { SpinupWPClientLike } from "../api/client.ts"
import { resolveSiteByDomain, type SshAccessCandidate, type SshAccessReason } from "./cliSsh.ts"
import { planLocalSetup, runLocalSetup, type LocalSetupStage } from "./localSetup.ts"
import { planDbSync, runDbSync, type DbSyncStage } from "./dbSync.ts"
import { readLink, writeLink } from "./links.ts"
import { expandPath } from "./local.ts"

export type PullReason =
  | SshAccessReason
  | "no_dest"
  | "ambiguous_dest"
  | "already_linked"
  | "dest_not_empty"
  | "plan_failed"
  | "fetch_failed"
  | "composer_failed"
  | "not_linked"
  | "missing_env"
  | "local_sync_disabled"
  | "not_confirmed"
  | "sync_failed"

export type PullCommand = "pull files" | "pull db"

export interface PullFailure {
  ok: false
  command: PullCommand
  domain: string
  reason: PullReason
  message: string
  remedy?: string
  candidates?: SshAccessCandidate[]
  failedStage?: string
}

export interface PullFilesSuccess {
  ok: true
  command: "pull files"
  domain: string
  primaryDomain: string
  path: string
  localUrl: string
  method: "git" | "rsync"
  ranComposer: boolean
  linked: true
  // Non-fatal caveats about the copy that just landed — most importantly the
  // things standing between it and a working `pull db`.
  warnings?: string[]
}

export interface PullDbSuccess {
  ok: true
  command: "pull db"
  domain: string
  primaryDomain: string
  path: string
  localUrl: string
  downloadPath: string
  localBackupPath: string
  ranHook: boolean
  warnings?: string[]
}

export type PullFilesResult = PullFilesSuccess | PullFailure
export type PullDbResult = PullDbSuccess | PullFailure

export type StageReporter = (line: string) => void

const FILES_STAGE_LABELS: Record<LocalSetupStage, string> = {
  fetch: "Getting the code down",
  build: "composer install",
  done: "Done",
  error: "Failed",
}

const DB_STAGE_LABELS: Record<DbSyncStage, string> = {
  "local-backup": "Backing up the local database first",
  export: "Exporting the production database",
  download: "Downloading the dump",
  import: "Importing into the local database",
  replace: "Rewriting production URLs to local",
  hook: "Running bin/sync.d/post-import.sh",
  done: "Done",
  error: "Failed",
}

// Shape a resolver failure (unknown domain, ambiguous domain, dead token, …)
// into this command's result type, preserving the shared reason codes.
function fromResolverFailure(command: PullCommand, failure: { ok: false } & Record<string, unknown>): PullFailure {
  const candidates = failure.candidates as SshAccessCandidate[] | undefined
  const remedy = failure.remedy != null ? String(failure.remedy) : undefined
  return {
    ok: false,
    command,
    domain: String(failure.domain ?? ""),
    reason: failure.reason as PullReason,
    message: String(failure.message ?? ""),
    ...(remedy ? { remedy } : {}),
    ...(candidates ? { candidates } : {}),
  }
}

export async function runPullFiles(
  domain: string,
  opts: { path?: string | null; url?: string | null; server?: string | null },
  client: SpinupWPClientLike,
  cfg: AppConfig,
  onStage: StageReporter,
): Promise<PullFilesResult> {
  const command: PullCommand = "pull files"
  const fail = (reason: PullReason, message: string, remedy?: string): PullFailure => ({
    ok: false,
    command,
    domain,
    reason,
    message,
    ...(remedy ? { remedy } : {}),
  })

  onStage(`Resolving ${domain} …`)
  const resolved = await resolveSiteByDomain(domain, client, cfg, { server: opts.server })
  if (!resolved.ok) return fromResolverFailure(command, resolved.result)
  const { site, server } = resolved
  onStage(`Site ${site.domain} on ${server.name} (${server.ip_address})`)

  // A site that already has a local copy is not re-pulled: this engine only
  // ever populates an empty directory, and re-syncing over an existing checkout
  // would clobber local work. Refuse and say where the copy already is.
  const existing = readLink(site.id)
  if (existing) {
    return fail(
      "already_linked",
      `${site.domain} already has a local copy at ${existing.path}.`,
      "Pull the database into it with `spinuptui pull db`, or unlink it first (run `spinuptui`, select the site, press L then x).",
    )
  }

  // Destination: the explicit argument, else derived as <localRoot>/<primary
  // domain>, so an agent handed only a domain never has to invent a filesystem
  // path. Only derived when there's exactly one root — with several configured
  // there's no way to tell which one this site belongs in (they're commonly
  // split by stack), and guessing would file a standard-WP site under Bedrock.
  let dest = opts.path?.trim() ?? ""
  if (!dest) {
    if (cfg.localRoots.length === 0) {
      return fail(
        "no_dest",
        "No destination path given, and no localRoots configured to derive one from.",
        `Pass a path (\`spinuptui pull files ${domain} <path>\`), or set "localRoots": ["~/your/dev/dir"] in ${configPath()}.`,
      )
    }
    if (cfg.localRoots.length > 1) {
      return fail(
        "ambiguous_dest",
        `No destination path given, and ${cfg.localRoots.length} localRoots are configured (${cfg.localRoots.join(", ")}) — which one this site belongs in isn't knowable from here.`,
        `Pass a path, e.g. \`spinuptui pull files ${domain} ${join(cfg.localRoots[0]!, site.domain)}\`.`,
      )
    }
    dest = join(cfg.localRoots[0]!, site.domain)
    onStage(`Destination derived from localRoots: ${dest}`)
  }
  const localUrl = opts.url?.trim() ?? ""

  const planned = planLocalSetup(site, server, cfg.sshUser, dest, localUrl)
  if (!planned.ok) {
    const reason: PullReason = /isn't empty/i.test(planned.error) ? "dest_not_empty" : "plan_failed"
    return fail(reason, planned.error)
  }
  const plan = planned.plan

  onStage(
    plan.isGit
      ? `Source: git clone ${plan.repoUrl}`
      : `Source: rsync ${plan.user}@${plan.host}:${plan.filesRoot}/ (excluding uploads and the caching drop-ins)`,
  )
  onStage(`Destination: ${plan.destPath}`)

  let lastStage: LocalSetupStage | null = null
  const result = await runLocalSetup(plan, (p) => {
    if (p.stage !== lastStage && p.stage !== "done" && p.stage !== "error") {
      lastStage = p.stage
      onStage(`${FILES_STAGE_LABELS[p.stage]} …`)
    }
  })

  if (result.stage === "error") {
    const reason: PullReason = result.failedStage === "build" ? "composer_failed" : "fetch_failed"
    return {
      ...fail(reason, result.error ?? "The pull failed."),
      ...(result.failedStage ? { failedStage: result.failedStage } : {}),
    }
  }

  // Link it exactly as the TUI's guided clone does — `pull db` and the TUI's
  // own `p`/`m` flows all key off this link.
  await writeLink(site.id, { domain: site.domain, path: plan.destPath, localUrl })
  onStage(`Linked ${site.domain} → ${plan.destPath}`)

  const warnings: string[] = []
  if (!localUrl) {
    warnings.push(
      `No local URL recorded. \`spinuptui pull db ${site.domain}\` needs one to rewrite production URLs — pass --url on the next run.`,
    )
  }
  // The rsync path copies the site's real wp-config.php, which holds
  // PRODUCTION's database credentials. Harmless in itself (SpinupWP's DB_HOST
  // is localhost, so nothing local can reach the production database through
  // it) but it means local wp-cli — and therefore `pull db` — authenticates as
  // the production DB user against the local server and is denied. Say so here
  // rather than letting it surface as a bare "Access denied" three steps later.
  // The mirror image on the git path: Bedrock/Radicle keep DB credentials and
  // WP_HOME in .env, which is deliberately NOT in the repo — so a fresh clone
  // has none, and wp-cli runs with empty DB settings (`mysqldump: unknown
  // variable 'pass='`). composer install having run is exactly the signal that
  // this is such a checkout.
  if (result.ranComposer && !existsSync(join(plan.destPath, ".env"))) {
    warnings.push(
      `No .env in the checkout — Bedrock/Radicle keep database credentials and WP_HOME there, and it isn't in the repo. Copy .env.example to .env and fill in DB_NAME / DB_USER / DB_PASSWORD / WP_HOME before running \`spinuptui pull db ${site.domain}\`.`,
    )
  }
  if (!plan.isGit && existsSync(join(plan.destPath, "wp-config.php"))) {
    warnings.push(
      `${join(plan.destPath, "wp-config.php")} came from production and still holds its database credentials. Point DB_NAME / DB_USER / DB_PASSWORD / DB_HOST at your local database before running \`spinuptui pull db ${site.domain}\`.`,
    )
  }

  return {
    ok: true,
    command,
    domain,
    primaryDomain: site.domain,
    path: plan.destPath,
    localUrl,
    method: plan.isGit ? "git" : "rsync",
    ranComposer: result.ranComposer === true,
    linked: true,
    ...(warnings.length ? { warnings } : {}),
  }
}

export async function runPullDb(
  domain: string,
  opts: { url?: string | null; yes: boolean; server?: string | null },
  client: SpinupWPClientLike,
  cfg: AppConfig,
  onStage: StageReporter,
): Promise<PullDbResult> {
  const command: PullCommand = "pull db"
  const fail = (reason: PullReason, message: string, remedy?: string): PullFailure => ({
    ok: false,
    command,
    domain,
    reason,
    message,
    ...(remedy ? { remedy } : {}),
  })

  // Both gates first, before any network call: a wrong domain in a script
  // should bounce off the confirmation, not off a fleet lookup.
  if (!cfg.localSync) {
    return fail(
      "local_sync_disabled",
      "Local database sync is disabled for this install.",
      `Set "localSync": true in ${configPath()} (or export SPINUPWP_LOCAL_SYNC=1) to enable it.`,
    )
  }
  if (!opts.yes) {
    return fail(
      "not_confirmed",
      `This overwrites the local database for ${domain} with production's.`,
      `Re-run with --yes once you're sure: \`spinuptui pull db ${domain} --yes\`.`,
    )
  }

  onStage(`Resolving ${domain} …`)
  const resolved = await resolveSiteByDomain(domain, client, cfg, { server: opts.server })
  if (!resolved.ok) return fromResolverFailure(command, resolved.result)
  const { site, server } = resolved

  let link = readLink(site.id)
  if (!link) {
    return fail(
      "not_linked",
      `${site.domain} has no local copy linked, so there's nothing to import into.`,
      `Run \`spinuptui pull files ${domain} <path> --url <local url>\` first.`,
    )
  }
  // `--url` here doubles as "set the local URL and then sync", which is how a
  // copy pulled without one becomes syncable without a detour through the TUI.
  const url = opts.url?.trim()
  if (url && url !== link.localUrl) {
    link = { ...link, localUrl: url }
    await writeLink(site.id, link)
    onStage(`Local URL set to ${url}`)
  }
  onStage(`Local copy: ${expandPath(link.path)}`)

  const planned = planDbSync(site, server, cfg.sshUser, link, new Date())
  if (!planned.ok) {
    return fail(
      "plan_failed",
      planned.error,
      /local URL/i.test(planned.error) ? `Pass --url <local url> (e.g. \`spinuptui pull db ${domain} --url https://example.test --yes\`).` : undefined,
    )
  }
  const plan = planned.plan

  // Fail on the real cause rather than letting empty DB settings surface three
  // steps later as `mysqldump: unknown variable 'pass='`.
  if ((plan.localKind === "bedrock" || plan.localKind === "radicle") && !existsSync(join(plan.localRoot, ".env"))) {
    return fail(
      "missing_env",
      `No .env in ${plan.localRoot} — this is a ${plan.localKind} checkout, so its database credentials live there and it isn't in the repo.`,
      "Copy .env.example to .env and fill in DB_NAME / DB_USER / DB_PASSWORD / WP_HOME, then re-run.",
    )
  }

  onStage(`Rewriting ${plan.remoteOrigin} → ${plan.localOrigin}`)
  if (plan.prefixWarning) onStage(`Warning: ${plan.prefixWarning}`)
  onStage(`A pre-import backup of the local database is written to ${plan.localBackupPath}`)

  let lastStage: DbSyncStage | null = null
  const result = await runDbSync(plan, site.domain, (p) => {
    if (p.stage !== lastStage && p.stage !== "done" && p.stage !== "error") {
      lastStage = p.stage
      onStage(`${DB_STAGE_LABELS[p.stage]} …`)
    }
  })

  if (result.stage === "error") {
    const error = result.error ?? "The sync failed."
    // The overwhelmingly likely cause right after `pull files`: the copied
    // wp-config.php still carries production's DB credentials, so local wp-cli
    // authenticates as the production user against the local MySQL.
    const deniedAs = /access denied for user '([^']+)'/i.exec(error)?.[1]
    return {
      ...fail(
        "sync_failed",
        error,
        deniedAs
          ? `Local MySQL refused the user "${deniedAs}". If this copy came from \`pull files\`, its wp-config.php still holds production's database credentials — point DB_NAME / DB_USER / DB_PASSWORD / DB_HOST at your local database and re-run.`
          : undefined,
      ),
      ...(result.failedStage ? { failedStage: result.failedStage } : {}),
    }
  }

  return {
    ok: true,
    command,
    domain,
    primaryDomain: site.domain,
    path: expandPath(link.path),
    localUrl: plan.localOrigin,
    downloadPath: result.downloadPath ?? plan.downloadPath,
    localBackupPath: result.localBackupPath ?? plan.localBackupPath,
    ranHook: result.ranHook === true,
    ...(plan.prefixWarning ? { warnings: [plan.prefixWarning] } : {}),
  }
}

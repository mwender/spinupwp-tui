// Set up a brand-new local working copy for a remote SpinupWP site — the
// missing first step before dbSync (`p`) and mediaFallback (`m`) can run.
//
// Gets the CODE down (git clone for git-deployed sites, an rsync pull over SSH
// for everything else — excluding uploads/ and the server-specific caching
// drop-ins, object-cache.php/advanced-cache.php: they're wired to production's
// Redis/disk cache, and object-cache.php doesn't just no-op without it, it
// fatals) and runs `composer install` locally when the checkout turns out to
// be Bedrock/Radicle. Deliberately stops there: it never touches the local
// database or webserver config, and never links the site itself — the caller
// does that (reusing `linkSite`) once this succeeds, then hands off to the
// existing dbSync (`p`) and mediaFallback (`m`) flows unchanged.
//
// For a public/-style webroot, wp-config.php lives ONE level above it (see
// CLAUDE.md's WordPress layout rules) — so the rsync path always pulls the
// site's whole files root, not just the detected webroot, so wp-config.php
// (and anything else living beside it) comes down too. `public_folder` is a
// SETTING, not a fact (SpinupWP never enforces it), so the real webroot is
// detected on the source via `detectWpDirScript` rather than trusted.

import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Server, Site } from "../api/types.ts"
import { expandPath, resolveLocalLink } from "./local.ts"
import { SSH_OPTS, sshPort, runProcess, meaningfulError } from "./dbBackup.ts"
import { detectWpDirScript } from "./serverClone.ts"

export interface LocalSetupPlan {
  domain: string
  isGit: boolean
  repoUrl: string | null // git clone source, when isGit
  user: string // SSH user — only needed for the non-git rsync path
  host: string
  port: number | null
  filesRoot: string // remote /sites/{domain}/files — rsync source root
  publicFolder: string | null // as configured; the real webroot is still detected, not trusted
  destPath: string // expanded local destination (must not exist, or be empty)
  destUrl: string
}

export type LocalSetupPlanResult = { ok: true; plan: LocalSetupPlan } | { ok: false; error: string }

export function planLocalSetup(
  site: Site,
  server: Server | undefined,
  sshUser: string | null,
  destPath: string,
  destUrl: string,
): LocalSetupPlanResult {
  const path = destPath.trim()
  if (!path) return { ok: false, error: "Enter a local path." }
  const dir = expandPath(path)
  if (existsSync(dir) && readdirSync(dir).length > 0) return { ok: false, error: "That path already exists and isn't empty." }

  const isGit = !!site.git?.repo
  const host = server?.ip_address
  const user = site.site_user ?? sshUser
  // Non-git sites are pulled over SSH, so they need a reachable server + user.
  // Git sites clone straight from the repo and never touch the server.
  if (!isGit && (!host || !user)) return { ok: false, error: "Missing site user or server IP — can't reach the site." }

  return {
    ok: true,
    plan: {
      domain: site.domain,
      isGit,
      repoUrl: site.git?.repo ?? null,
      user: user ?? "",
      host: host ?? "",
      port: server?.ssh_port ?? null,
      filesRoot: `/sites/${site.domain}/files`,
      publicFolder: site.public_folder,
      destPath: dir,
      destUrl: destUrl.trim(),
    },
  }
}

export type LocalSetupStage = "fetch" | "build" | "done" | "error"

export interface LocalSetupProgress {
  stage: LocalSetupStage
  domain: string
  destPath?: string
  error?: string
  failedStage?: LocalSetupStage
  ranComposer?: boolean
}

export function isLocalSetupInFlight(p: LocalSetupProgress | undefined): boolean {
  return p != null && p.stage !== "done" && p.stage !== "error"
}

// rsync the source's whole files root down, excluding uploads wherever they
// land (relative to the detected webroot, not assumed at the files root).
async function fetchByRsync(plan: LocalSetupPlan): Promise<{ code: number; stderr: string }> {
  const target = `${plan.user}@${plan.host}`
  const probeScript = `${detectWpDirScript(plan.filesRoot, plan.publicFolder ?? undefined)}; echo "D:$D"; echo "W:$W"`
  const probe = await runProcess(["ssh", ...SSH_OPTS, ...sshPort(plan.port), target, probeScript], 30_000)
  if (probe.code !== 0) return { code: probe.code, stderr: probe.stderr }
  const d = probe.stdout.match(/^D:(.*)$/m)?.[1]?.trim()
  const w = probe.stdout.match(/^W:(.*)$/m)?.[1]?.trim()
  if (!d) return { code: 1, stderr: "couldn't determine the site's files root on the server." }
  if (!w) return { code: 1, stderr: "couldn't find a WordPress install under this site on the server." }

  // Paths relative to the files root we're about to rsync, e.g.
  // "public/wp-content/uploads" when the webroot sits below the files root, or
  // bare "wp-content/uploads" when it doesn't.
  const webrootRel = w === d ? "" : w.slice(d.length).replace(/^\/+/, "")
  const contentRel = (name: string) => (webrootRel ? `${webrootRel}/wp-content/${name}` : `wp-content/${name}`)
  // object-cache.php (and advanced-cache.php, same family) are server drop-ins
  // wired to production's Redis/disk cache — they don't just no-op without it,
  // they fatal (confirmed: SpinupWP's object-cache drop-in 500s on a cache MISS
  // when Redis is unreachable). Local dev doesn't want production caching
  // anyway, so these are excluded outright rather than copied and hoping.
  const excludes = ["uploads", "object-cache.php", "advanced-cache.php"].map((name) => `--exclude=${contentRel(name)}`)

  const sshCmd = ["ssh", ...SSH_OPTS, ...sshPort(plan.port)].join(" ")
  return runProcess(["rsync", "-az", "-e", sshCmd, ...excludes, `${target}:${d}/`, `${plan.destPath}/`], 600_000)
}

export async function runLocalSetup(plan: LocalSetupPlan, onProgress: (p: LocalSetupProgress) => void): Promise<LocalSetupProgress> {
  const domain = plan.domain
  const fail = (error: string, failedStage: LocalSetupStage = "fetch"): LocalSetupProgress => {
    const p: LocalSetupProgress = { stage: "error", domain, error, failedStage }
    onProgress(p)
    return p
  }
  const stageFail = (label: string, stderr: string, fallback: string, failedStage: LocalSetupStage) =>
    fail(`${label} — ${meaningfulError(stderr, fallback)}`, failedStage)

  onProgress({ stage: "fetch", domain })
  try {
    mkdirSync(dirname(plan.destPath), { recursive: true })
  } catch {
    // best-effort — the actual clone/rsync surfaces a real error if this truly can't be created
  }

  if (plan.isGit) {
    if (!plan.repoUrl) return fail("This site has no git repo configured in SpinupWP.", "fetch")
    const cl = await runProcess(["git", "clone", plan.repoUrl, plan.destPath], 300_000)
    if (cl.code !== 0) return stageFail("git clone failed", cl.stderr, `exit ${cl.code}.`, "fetch")
  } else {
    mkdirSync(plan.destPath, { recursive: true })
    const rs = await fetchByRsync(plan)
    if (rs.code !== 0) return stageFail("File pull failed", rs.stderr, `exit ${rs.code}.`, "fetch")
  }

  // Bedrock/Radicle needs `composer install` to build vendor/ + web/wp before
  // anything (wp-cli included) can find a WordPress install in the checkout.
  // Standard WP ships its core in the tree already, so this is a no-op there.
  const kind = resolveLocalLink({ domain, path: plan.destPath, localUrl: plan.destUrl }).kind
  let ranComposer = false
  if (kind === "bedrock" || kind === "radicle") {
    onProgress({ stage: "build", domain })
    const ci = await runProcess(["bash", "-lc", "composer install"], 300_000, plan.destPath)
    if (ci.code !== 0) return stageFail("composer install failed", ci.stderr, "composer error.", "build")
    ranComposer = true
  }

  const done: LocalSetupProgress = { stage: "done", domain, destPath: plan.destPath, ranComposer }
  onProgress(done)
  return done
}

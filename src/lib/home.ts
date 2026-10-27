// The SpinupTUI folder (~/SpinupTUI by default): where modules keep the user's
// work. Three levels, from docs/2026-10-27_spinuptui-home-spec.md:
//
// 0. It just works: created on first use, and the path is shown wherever
//    something lands in it.
// 1. It explains itself: a README.md written when the folder is created, saying
//    what each part is, who writes it, and how to move or share it.
// 2. Sharing it across machines is an opt-in action (`spinuptui home sync`, and
//    the Modules tab), shown as a plan and confirmed: git init, a .gitignore, a
//    first commit, a private remote, a push. Or, on a second machine, a clone.
//    Nothing here ever runs git or creates a remote on its own.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, sep } from "node:path"
import { configDir, loadConfig } from "../config.ts"
import { spinuptuiHome } from "../modules/contract.ts"
import { tryLock } from "./flock.ts"
import { spawn } from "./spawn.ts"
import { jobEnv } from "./schedulerRun.ts"
import { gitRootOf, LOCAL_SOURCE, schedulerStateDir } from "./schedulerJobs.ts"
import { readClaim, stationName } from "./schedulerGit.ts"

export const tilde = (p: string) => {
  const h = homedir()
  return p === h ? "~" : p.startsWith(h + sep) ? "~" + p.slice(h.length) : p
}

// ---- level 1: the README ------------------------------------------------------------

export function readmeText(): string {
  return `# SpinupTUI

This folder holds what SpinupTUI's modules make for you: the things you read, keep or share. SpinupTUI created it the first time it needed it, and you can open, back up or search it like any other folder.

## What's here

- \`scheduler/jobs/\` holds your queued follow-ups, one Markdown file each. They're yours: add them with \`spinuptui scheduler add\`, or write and edit them by hand and check them with \`spinuptui scheduler validate\`.
- \`scheduler/runs/\` holds a report for every run, plus each job's \`state.json\`. The machine that runs the jobs writes these. Read them freely, but don't edit them.
- \`scheduler/.scheduler/station\` names the machine that runs these jobs, once this folder is shared. Change it with \`spinuptui scheduler source claim\` or \`release\`, not by hand.

Other modules add a folder of their own here when you turn them on.

## What's not here

Settings, tokens and passwords stay in SpinupTUI's config directory (\`${tilde(configDir())}\`), along with locks and logs. Nothing in this folder is a secret by design, but reports can name your sites and clients, so treat it as private.

## Using it from more than one machine

\`spinuptui home sync --plan\` shows how to turn this folder into a git repository with a private remote. Then you can queue jobs from a laptop and read the reports anywhere. On the other machine, \`spinuptui home sync --clone <url> --plan\` sets up the same folder there. \`spinuptui home\` shows where things stand.

## Moving it

Set \`homeDir\` in SpinupTUI's \`config.json\`, or the \`SPINUPTUI_HOME\` environment variable. Once it's a git repository, keep it out of iCloud, Dropbox and similar sync folders: two programs syncing the same \`.git\` folder can corrupt it.
`
}

const GITIGNORE = `# SpinupTUI folder: written by \`spinuptui home sync\`
.DS_Store
*.tmp
.state/
`

// Creates the folder and its README if either is missing. Never overwrites the
// README, which is the user's to edit once it exists. Returns true if it wrote it.
export function ensureHome(home = spinuptuiHome()): boolean {
  mkdirSync(home, { recursive: true })
  const readme = join(home, "README.md")
  if (existsSync(readme)) return false
  writeFileSync(readme, readmeText())
  return true
}

const inside = (child: string, parent: string) => {
  const r = relative(parent, child)
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep))
}

// mkdir -p for a module writing its work, plus the README when the directory is
// inside the SpinupTUI folder: whichever module writes first explains the folder.
export function prepareWorkDir(dir: string): void {
  const home = spinuptuiHome()
  if (inside(dir, home)) ensureHome(home)
  mkdirSync(dir, { recursive: true })
}

// ---- where things stand -----------------------------------------------------------

// A sync service that also writes inside the folder. Two syncers on one .git
// produce conflicted copies and can corrupt the index.
export function cloudSyncedBy(path: string): string | null {
  let p = path
  try {
    p = realpathSync(path)
  } catch {
    // Not created yet: judge the configured path.
  }
  const h = homedir()
  if (p.includes("/Library/Mobile Documents/")) return "iCloud Drive"
  const cs = p.match(/\/Library\/CloudStorage\/([^/]+)/)
  if (cs) return cs[1]!.split("-")[0]!.replace("GoogleDrive", "Google Drive")
  if (/\/(Dropbox|Dropbox \([^)]*\))(\/|$)/.test(p)) return "Dropbox"
  const other = p.match(/\/(OneDrive|Google Drive|pCloud Drive)(\/|$)/)
  if (other) return other[1]!
  // macOS "Desktop & Documents Folders" in iCloud, when it's turned on.
  for (const d of ["Desktop", "Documents"]) {
    if (inside(p, join(h, d)) && existsSync(join(h, "Library", "Mobile Documents", "com~apple~CloudDocs", d))) return `iCloud Drive (${d})`
  }
  return null
}

export async function run(cmd: string[], cwd?: string): Promise<{ code: number; out: string }> {
  try {
    const p = spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...jobEnv(), GIT_TERMINAL_PROMPT: "0" } })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, out: (out + err).trim() }
  } catch (e) {
    return { code: 127, out: e instanceof Error ? e.message : String(e) }
  }
}

const git = (dir: string, ...args: string[]) => run(["git", "-C", dir, ...args])

export interface HomeStatus {
  path: string
  exists: boolean
  readme: boolean
  syncedBy: string | null
  // The folder is its own repository.
  git: boolean
  // Some other repository contains it (a project checkout, say).
  insideRepo: string | null
  remote: string | null
  branch: string | null
  // Commits not yet pushed / not yet pulled; null when unknown (no upstream).
  ahead: number | null
  behind: number | null
  station: string | null
  thisMachine: string
}

export async function homeStatus(home = spinuptuiHome()): Promise<HomeStatus> {
  const exists = existsSync(home)
  // gitRootOf walks up from a path that needn't exist yet, so a folder still to
  // be created inside a project checkout is caught too.
  const root = gitRootOf(home)
  const own = root === home
  const s: HomeStatus = {
    path: home,
    exists,
    readme: existsSync(join(home, "README.md")),
    syncedBy: cloudSyncedBy(home),
    git: own,
    insideRepo: root && !own ? root : null,
    remote: null,
    branch: null,
    ahead: null,
    behind: null,
    station: own ? readClaim({ name: LOCAL_SOURCE, path: join(home, "scheduler"), gitRoot: home, git: true, queueOnly: false }) : null,
    thisMachine: stationName(),
  }
  if (!own) return s
  const r = await git(home, "remote", "get-url", "origin")
  if (r.code === 0) s.remote = r.out
  const b = await git(home, "symbolic-ref", "--short", "-q", "HEAD")
  if (b.code === 0) s.branch = b.out
  const c = await git(home, "rev-list", "--left-right", "--count", "HEAD...@{u}")
  if (c.code === 0) {
    const [a, bh] = c.out.split(/\s+/).map(Number)
    s.ahead = a ?? null
    s.behind = bh ?? null
  }
  return s
}

export function describeShare(s: HomeStatus): string {
  if (s.insideRepo) return `inside another repository (${tilde(s.insideRepo)})`
  if (!s.git) return "on this machine only"
  if (!s.remote) return "a git repository with no remote yet"
  const pending =
    s.ahead === null ? ", not pushed yet" : s.ahead || s.behind ? `, ${[s.ahead ? `${s.ahead} to push` : "", s.behind ? `${s.behind} to pull` : ""].filter(Boolean).join(", ")}` : ", up to date"
  return `shared via ${s.remote}${pending}`
}

// ---- level 2: the sync plan -------------------------------------------------------------

export interface SyncOptions {
  // An existing, empty repository to push to.
  remote?: string
  // Create a private GitHub repository with `gh` (owner/name or name).
  github?: string
  // Second machine: clone an existing SpinupTUI folder here.
  clone?: string
}

export interface PlanStep {
  label: string
  apply: () => Promise<string | null> // null = done, else why it failed
}

export interface SyncPlan {
  mode: "share" | "clone" | "repair" | "nothing"
  home: string
  steps: PlanStep[]
  notes: string[]
  // Any of these and the plan can't be applied.
  blockers: { reason: string; message: string; remedy?: string }[]
}

const PRIVATE_NOTE =
  "Use a private repository. Nothing here is a secret by design, but reports and write-ups name your sites and clients."

const ghHost = (url: string) => /^(https:\/\/|git@|ssh:\/\/git@)github\.com[/:]/.test(url)

export async function ghReady(): Promise<string | null> {
  const v = await run(["gh", "--version"])
  if (v.code !== 0) return "The GitHub CLI (gh) isn't installed."
  const a = await run(["gh", "auth", "status"])
  if (a.code !== 0) return "The GitHub CLI isn't signed in (gh auth login)."
  return null
}

// What `gh` says about a GitHub URL's visibility, when it can tell.
async function githubVisibility(url: string): Promise<string | null> {
  if (!ghHost(url) || (await ghReady())) return null
  const v = await run(["gh", "repo", "view", url, "--json", "visibility", "-q", ".visibility"])
  return v.code === 0 ? v.out.trim().toUpperCase() : null
}

// Only what SpinupTUI itself put there: a folder holding nothing else can be
// replaced by a clone.
function onlyOurFiles(home: string): boolean {
  if (!existsSync(home)) return true
  for (const name of readdirSync(home)) {
    if (name === ".DS_Store") continue
    if (name === "README.md" && readFileSync(join(home, name), "utf8") === readmeText()) continue
    return false
  }
  return true
}

export async function planSync(opts: SyncOptions, home = spinuptuiHome()): Promise<SyncPlan> {
  const plan: SyncPlan = { mode: "share", home, steps: [], notes: [], blockers: [] }
  const block = (reason: string, message: string, remedy?: string) => plan.blockers.push({ reason, message, ...(remedy ? { remedy } : {}) })
  const given = [opts.remote, opts.github, opts.clone].filter(Boolean).length
  if (given > 1) block("usage", "Give one of --remote, --github or --clone.")

  if ((await run(["git", "--version"])).code !== 0) block("no_git", "git isn't installed on this machine.", "Install git, then run this again.")
  const synced = cloudSyncedBy(home)
  if (synced) {
    block(
      "cloud_synced",
      `${tilde(home)} is inside ${synced}. Two programs syncing the same .git folder can corrupt it.`,
      "Move the SpinupTUI folder out of it first (homeDir in config.json, or SPINUPTUI_HOME), then run this again.",
    )
  }
  const st = await homeStatus(home)
  if (st.insideRepo) {
    block("inside_repo", `${tilde(home)} is inside another git repository (${tilde(st.insideRepo)}).`, "Point the SpinupTUI folder somewhere of its own (homeDir in config.json, or SPINUPTUI_HOME).")
  }

  // ---- second machine ----
  if (opts.clone) {
    plan.mode = "clone"
    const url = opts.clone
    if (st.git) block("already_repo", `${tilde(home)} is already a git repository${st.remote ? ` (origin ${st.remote})` : ""}.`, "Nothing to clone: `spinuptui home` shows its state.")
    else if (!onlyOurFiles(home)) {
      block(
        "not_empty",
        `${tilde(home)} already has work in it, and a clone would need an empty folder.`,
        "To combine them, move this folder's contents aside, clone, then copy back the jobs you want to keep.",
      )
    }
    const ls = await run(["git", "ls-remote", "--heads", url])
    if (ls.code !== 0) block("unreachable", `Couldn't reach ${url}: ${ls.out.split("\n")[0]}`, "Check the URL and that this machine's git credentials can read it.")
    else if (!ls.out) block("empty_remote", `${url} is empty, so there's nothing to clone.`, "Run `spinuptui home sync` on the machine that has the folder first.")
    if (plan.blockers.length) return plan
    if (existsSync(home)) {
      plan.steps.push({
        label: `Remove the SpinupTUI folder's starter README (the clone brings its own)`,
        apply: async () => {
          for (const n of ["README.md", ".DS_Store"]) if (existsSync(join(home, n))) unlinkSync(join(home, n))
          return null
        },
      })
    }
    plan.steps.push({
      label: `Clone ${url} into ${tilde(home)}`,
      apply: async () => {
        const r = await run(["git", "clone", "--quiet", url, home])
        return r.code === 0 ? null : `git clone failed: ${r.out}`
      },
    })
    plan.notes.push(cloneNote())
    return plan
  }

  // ---- this machine has the folder ----
  if (st.git && st.remote) {
    if (opts.remote && opts.remote !== st.remote) block("has_remote", `${tilde(home)} already pushes to ${st.remote}.`, `Change it with: git -C ${tilde(home)} remote set-url origin ${opts.remote}`)
    if (opts.github) block("has_remote", `${tilde(home)} already pushes to ${st.remote}.`)
    if (plan.blockers.length) return plan
    if (st.ahead === null) {
      plan.mode = "repair"
      plan.steps.push(pushStep(home, "Push to origin and track it"))
    } else if (st.ahead > 0) {
      plan.mode = "repair"
      plan.steps.push(pushStep(home, `Push ${st.ahead} unpushed commit${st.ahead === 1 ? "" : "s"}`))
    } else plan.mode = "nothing"
    const vis = await githubVisibility(st.remote)
    if (vis === "PUBLIC") plan.notes.push(`Warning: ${st.remote} is PUBLIC on GitHub. ${PRIVATE_NOTE}`)
    return plan
  }

  if (!opts.remote && !opts.github) {
    block(
      "need_remote",
      "Say where to keep it: an empty private repository you've made (--remote <url>), or one to create on GitHub (--github <name>, needs the GitHub CLI).",
      "e.g. spinuptui home sync --github spinuptui-home --plan",
    )
    return plan
  }
  if (opts.github) {
    const why = await ghReady()
    if (why) block("no_gh", why, "Or make an empty private repository anywhere and pass --remote <url>.")
  }
  if (opts.remote) {
    const ls = await run(["git", "ls-remote", "--heads", opts.remote])
    if (ls.code !== 0) block("unreachable", `Couldn't reach ${opts.remote}: ${ls.out.split("\n")[0]}`, "Check the URL and that this machine's git credentials can write to it.")
    else if (ls.out) {
      block(
        "remote_not_empty",
        `${opts.remote} already has commits.`,
        "To join a SpinupTUI folder another machine already shares, use --clone on a machine whose folder is empty. Otherwise make a new, empty repository.",
      )
    }
    const vis = await githubVisibility(opts.remote)
    if (vis === "PUBLIC") block("public_repo", `${opts.remote} is public on GitHub. ${PRIVATE_NOTE}`, "Make it private (gh repo edit --visibility private) or use another repository.")
  }
  if (plan.blockers.length) return plan

  if (!existsSync(home) || !existsSync(join(home, "README.md"))) {
    plan.steps.push({ label: `Write ${tilde(join(home, "README.md"))}, which explains the folder`, apply: async () => (ensureHome(home), null) })
  }
  if (!st.git) {
    plan.steps.push({
      label: `Make ${tilde(home)} a git repository (git init)`,
      apply: async () => {
        mkdirSync(home, { recursive: true })
        const r = await git(home, "init", "--quiet", "-b", "main")
        return r.code === 0 ? null : `git init failed: ${r.out}`
      },
    })
  }
  if (!existsSync(join(home, ".gitignore"))) {
    plan.steps.push({
      label: "Add a .gitignore (macOS clutter, temp files, local locks)",
      apply: async () => (writeFileSync(join(home, ".gitignore"), GITIGNORE), null),
    })
  }
  const hasHead = st.git && (await git(home, "rev-parse", "--verify", "-q", "HEAD")).code === 0
  if (!hasHead) {
    plan.steps.push({
      label: "Commit what's there now",
      apply: async () => {
        await git(home, "add", "-A")
        const r = await git(home, "commit", "--quiet", "-m", "SpinupTUI folder: first commit")
        return r.code === 0 ? null : `git commit failed: ${r.out}`
      },
    })
  }
  if (opts.github) {
    plan.steps.push({
      label: `Create the private GitHub repository ${opts.github} and make it origin`,
      apply: async () => {
        const r = await run(["gh", "repo", "create", opts.github!, "--private", "--source", home, "--remote", "origin"])
        return r.code === 0 ? null : `gh repo create failed: ${r.out}`
      },
    })
  } else {
    plan.steps.push({
      label: `Set origin to ${opts.remote}`,
      apply: async () => {
        const r = await git(home, "remote", "add", "origin", opts.remote!)
        return r.code === 0 ? null : `git remote add failed: ${r.out}`
      },
    })
  }
  plan.steps.push(pushStep(home, "Push it"))
  plan.notes.push(PRIVATE_NOTE)
  plan.notes.push(shareNote())
  return plan
}

function pushStep(home: string, label: string): PlanStep {
  return {
    label,
    apply: async () => {
      const r = await git(home, "push", "--quiet", "-u", "origin", "HEAD")
      return r.code === 0 ? null : `git push failed: ${r.out}`
    },
  }
}

const dispatcherHere = () => !!loadConfig().scheduler?.dispatcher

function shareNote(): string {
  return dispatcherHere()
    ? "Scheduler then pulls the folder before each run and pushes the reports, and this machine claims its jobs on the next tick. On another machine: spinuptui home sync --clone <url> --plan"
    : "Scheduler then pulls the folder before each run and pushes the reports. On another machine: spinuptui home sync --clone <url> --plan"
}

function cloneNote(): string {
  return dispatcherHere()
    ? "This machine has a Scheduler dispatcher. If another station already runs these jobs, this one only queues to them; if none does, the first dispatcher to tick claims them."
    : "This machine has no Scheduler dispatcher, so it only queues jobs: `spinuptui scheduler add` commits and pushes them for the station to run."
}

export interface ApplyResult {
  ok: boolean
  done: string[]
  failed?: { step: string; message: string }
}

// Runs the plan's steps in order, stopping at the first failure. Holds the
// Scheduler tick lock so a tick can't pull, commit or push mid-way.
export async function applySync(plan: SyncPlan): Promise<ApplyResult> {
  mkdirSync(schedulerStateDir(), { recursive: true })
  const lock = tryLock(join(schedulerStateDir(), "tick.lock"))
  if (!lock) return { ok: false, done: [], failed: { step: "wait for Scheduler", message: "A Scheduler tick is running. Try again in a minute." } }
  const done: string[] = []
  try {
    for (const s of plan.steps) {
      const err = await s.apply()
      if (err) return { ok: false, done, failed: { step: s.label, message: err } }
      done.push(s.label)
    }
    return { ok: true, done }
  } finally {
    lock.release()
  }
}

// One Scheduler tick: what the dispatcher runs every 5 minutes.
//
//   1. Take the tick lock (a tick still running from last time wins).
//   2. Run due module jobs (ScheduledJobDecl), paging only when one starts or
//      stops failing.
//   3. For each source: take its lock, pull it if it's a git repository, run
//      each due follow-up in turn, commit and push runs/.
//   4. Record the tick in last-tick.json (every dispatcher tick; status() reads
//      it) and in tick.log (any tick where something ran or failed).
//
// See docs/2026-10-20_scheduler-spec.md.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../config.ts"
import { MODULES } from "../modules/index.ts"
import type { ScheduledJobDecl } from "../modules/contract.ts"
import { tryLock } from "./flock.ts"
import { declSchedule, dueOccurrence, fmt, parseWhen } from "./schedule.ts"
import { ID_RE, lastTickPath, listSources, loadJobs, loadState, saveState, schedulerStateDir, sourceLockPath, tickLogPath, type Source, type TickRecord, type TickRun } from "./schedulerJobs.ts"
import { jobEnv, notify, runJob, runProcess, selfCommand } from "./schedulerRun.ts"
import { spawn } from "./spawn.ts"

const LOG_MAX_BYTES = 1_000_000
const MODULE_JOB_TIMEOUT_MS = 10 * 60_000

export type TickResult = ({ ok: true } & TickRecord) | { ok: true; skipped: "locked"; message: string }

// ---- git --------------------------------------------------------------------------

export async function git(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const p = spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: jobEnv() })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: (out + err).trim() }
}

export async function gitPull(dir: string): Promise<string | null> {
  const r = await git(dir, "pull", "--rebase", "--autostash", "--quiet")
  return r.code === 0 ? null : `git pull failed: ${r.out}`
}

// Commits runs/ when it changed, and pushes whenever the branch is ahead, so a
// push that failed on an earlier tick is retried.
async function commitAndPushRuns(dir: string, message: string): Promise<string | null> {
  await git(dir, "add", "--", "runs")
  if ((await git(dir, "diff", "--cached", "--quiet")).code !== 0) await git(dir, "commit", "--quiet", "-m", message)
  const ahead = await git(dir, "rev-list", "--count", "@{u}..HEAD")
  if (ahead.code === 0 && ahead.out !== "" && ahead.out !== "0") {
    await gitPull(dir)
    const r = await git(dir, "push", "--quiet")
    if (r.code !== 0) return `git push failed (retried next tick): ${r.out}`
  }
  return null
}

// ---- module jobs -----------------------------------------------------------------

export interface ModuleJobState {
  last_run?: string
  last_scheduled?: string
  last_status?: "ok" | "failed"
  failing_since?: string
  last_output?: string
}

export interface ModuleJobDeps {
  stateDir: string
  now: Date
  run(decl: ScheduledJobDecl): Promise<{ ok: boolean; output: string }>
  page(text: string): Promise<string>
}

function moduleJobStatePath(dir: string, id: string) {
  return join(dir, "module-jobs", `${id}.json`)
}

// Runs whichever declarations are due. Pages when a job starts failing and when
// it recovers — never on every failed run, so a broken heartbeat can't train
// anyone to ignore the pager.
export async function runModuleJobs(decls: ScheduledJobDecl[], deps: ModuleJobDeps): Promise<{ ran: TickRun[]; errors: string[] }> {
  const ran: TickRun[] = []
  const errors: string[] = []
  for (const decl of decls) {
    const path = moduleJobStatePath(deps.stateDir, decl.id)
    let state: ModuleJobState = {}
    try {
      state = JSON.parse(readFileSync(path, "utf8")) as ModuleJobState
    } catch {
      // First run.
    }
    let occ: Date | null
    try {
      if (decl.command[0] === "scheduler") throw new Error("a module job can't run `scheduler`")
      occ = dueOccurrence({ schedule: declSchedule(decl) }, state, deps.now)
    } catch (err) {
      errors.push(`module job ${decl.id}: ${(err as Error).message}`)
      continue
    }
    if (!occ) continue
    // The tick's time, not the wall clock after earlier jobs: intervals stay
    // aligned to ticks instead of drifting by each run's duration.
    const started = deps.now
    const r = await deps.run(decl)
    const status = r.ok ? "ok" : "failed"
    const tail = r.output.trim().split("\n").slice(-10).join("\n").slice(-600)
    let notified: string | undefined
    if (status === "failed" && state.last_status !== "failed") {
      notified = await deps.page(`⚠️ ${decl.id} failed (spinuptui ${decl.command.join(" ")})\n\n${tail || "(no output)"}`)
      state.failing_since = fmt(started)
    } else if (status === "ok" && state.last_status === "failed") {
      notified = await deps.page(`✅ ${decl.id} is working again (failing since ${state.failing_since ?? "?"})`)
      delete state.failing_since
    }
    state.last_status = status
    state.last_run = fmt(started)
    state.last_scheduled = fmt(occ)
    state.last_output = tail
    mkdirSync(join(deps.stateDir, "module-jobs"), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n")
    ran.push({ source: "module", id: decl.id, status, ...(notified ? { notified } : {}) })
  }
  return { ran, errors }
}

async function configuredModuleJobs(): Promise<ScheduledJobDecl[]> {
  const out: ScheduledJobDecl[] = []
  for (const m of MODULES) {
    if (m.jobs.length === 0) continue
    const s = await m.status().catch(() => null)
    if (s && s.state !== "not_configured") out.push(...m.jobs)
  }
  return out
}

// ---- sources ---------------------------------------------------------------------

async function tickSource(source: Source, now: Date, only: string | null, force: boolean): Promise<{ ran: TickRun[]; errors: string[] }> {
  const ran: TickRun[] = []
  const errors: string[] = []
  if (!existsSync(source.path)) return { ran, errors: [`source ${source.name}: ${source.path} does not exist`] }
  const lock = tryLock(sourceLockPath(source))
  if (!lock) return { ran, errors: [`source ${source.name}: busy (another dispatcher holds its lock); skipped this tick`] }
  try {
    if (source.git) {
      const e = await gitPull(source.path)
      if (e) errors.push(`source ${source.name}: ${e}`)
    }
    for (const job of loadJobs(source)) {
      const id = job.header.id
      if (only && id !== only) continue
      if (job.problems.length) {
        if (!id || !ID_RE.test(id)) continue
        const sig = job.problems.join("; ")
        const state = loadState(source, id)
        if (state.invalid !== sig) {
          state.invalid = sig
          saveState(source, id, state)
          const notified = await notify(`⚠️ Job file ${source.name}/jobs/${job.name} is invalid and was skipped: ${sig}`)
          ran.push({ source: source.name, id, status: "invalid", notified })
        }
        continue
      }
      const state = loadState(source, id!)
      if (state.invalid !== undefined) {
        delete state.invalid
        saveState(source, id!, state)
      }
      let occ: Date | null
      try {
        occ = force ? forcedOccurrence(job.header.when, now) : dueOccurrence(job.header, state, now)
      } catch (err) {
        errors.push(`job ${source.name}/${id}: ${(err as Error).message}`)
        continue
      }
      if (!occ) continue
      process.stderr.write(`→ running ${source.name}/${id} (scheduled ${fmt(occ)})\n`)
      const outcome = await runJob(source, job, occ, now)
      ran.push({ source: source.name, id: id!, ...outcome })
    }
    if (source.git) {
      const mine = ran.filter((r) => r.source === source.name)
      const e = await commitAndPushRuns(source.path, "runs: " + (mine.length ? mine.map((r) => `${r.id} (${r.status})`).join(", ") : "state"))
      if (e) errors.push(`source ${source.name}: ${e}`)
    }
  } finally {
    lock.release()
  }
  return { ran, errors }
}

// `scheduler run`: a one-shot whose time has passed is recorded as its own slot,
// so the next tick doesn't run it again; anything else runs as "now".
function forcedOccurrence(when: string | undefined, now: Date): Date {
  if (when) {
    const w = parseWhen(when)
    if (w <= now) return w
  }
  return new Date(new Date(now).setSeconds(0, 0))
}

// ---- tick ------------------------------------------------------------------------

export interface TickOptions {
  via: "dispatcher" | "manual"
  // `scheduler run <id>`: one job, now, whether due or not.
  only?: { source: string; id: string }
  now?: Date
}

export async function tick(opts: TickOptions): Promise<TickResult> {
  const dir = schedulerStateDir()
  mkdirSync(dir, { recursive: true })
  const lock = tryLock(join(dir, "tick.lock"))
  if (!lock) return { ok: true, skipped: "locked", message: "A previous tick is still running." }
  const startedAt = Date.now()
  const now = opts.now ?? new Date()
  const ran: TickRun[] = []
  const errors: string[] = []
  try {
    if (!opts.only) {
      const decls = await configuredModuleJobs()
      if (decls.length) {
        const r = await runModuleJobs(decls, {
          stateDir: dir,
          now,
          run: async (decl) => {
            const p = await runProcess([...selfCommand(), ...decl.command], { cwd: dir, env: jobEnv(), timeoutMs: MODULE_JOB_TIMEOUT_MS })
            return { ok: p.code === 0, output: p.output }
          },
          page: (text) => notify(text),
        })
        ran.push(...r.ran)
        errors.push(...r.errors)
      }
    }
    for (const source of listSources(loadConfig())) {
      if (opts.only && source.name !== opts.only.source) continue
      const r = await tickSource(source, now, opts.only?.id ?? null, !!opts.only)
      ran.push(...r.ran)
      errors.push(...r.errors)
    }
    for (const r of ran) if (r.notified && r.notified !== "sent" && r.notified !== "skipped") errors.push(`${r.source}/${r.id}: not paged (${r.notified})`)
    const record: TickRecord = { at: new Date().toISOString(), via: opts.via, durationMs: Date.now() - startedAt, ran, errors }
    // Only the dispatcher's ticks count as "the station is alive": a manual
    // `run` or `tick --here` must not mask a dispatcher that has stopped.
    if (opts.via === "dispatcher") {
      writeFileSync(`${lastTickPath()}.tmp`, JSON.stringify(record, null, 2) + "\n")
      renameSync(`${lastTickPath()}.tmp`, lastTickPath())
    }
    if (ran.length || errors.length) appendTickLog(record)
    return { ok: true, ...record }
  } finally {
    lock.release()
  }
}

function appendTickLog(record: TickRecord): void {
  try {
    const path = tickLogPath()
    const size = existsSync(path) ? statSync(path).size : 0
    if (size > LOG_MAX_BYTES) renameSync(path, `${path}.1`)
    appendFileSync(path, JSON.stringify(record) + "\n")
  } catch {
    // The log is history; losing a line must not fail the tick.
  }
}

// Running one Scheduler job: the kinds, the agent adapters, the report and state
// it leaves behind, and the Beacon message about it.
//
// The report/state layout and the agent rules (read-only by default, a fixed
// always-deny list, a SUMMARY: paragraph as the digest, a lapsed login retried
// rather than counted as a run) carry over from the git-backed job runner; see
// docs/2026-10-20_scheduler-spec.md.

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { hostname, homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../config.ts"
import { beaconFromConfig, beaconSend } from "./beacon.ts"
import { pageMarkup } from "./beaconListenInstall.ts"
import type { BeaconButton } from "../modules/contract.ts"
import { spawn } from "./spawn.ts"
import { prepareWorkDir } from "./home.ts"
import { fmt } from "./schedule.ts"
import { agentOf, DEFAULT_TIMEOUT_MIN, expandHome, loadState, runsDir, saveState, splitArgs, type Job, type Source } from "./schedulerJobs.ts"

export const DEFAULT_ALLOW = "Read,Grep,Glob"
// Never allowed in a claude job, whatever its allow: line says.
export const ALWAYS_DENY = "Bash(git push *),Bash(git reset *),Bash(git clean *),Bash(rm -rf *),Bash(sudo *)"
// A script (or a `spinuptui` job) that exits with this ran but couldn't do its
// work because of something outside it: EX_TEMPFAIL. An agent says so in text.
export const BLOCKED_EXIT = 75
export const BLOCKED_RE = /^\s*STATUS:\s*blocked\b/im
export const AUTH_FAIL_RE =
  /Failed to authenticate|OAuth (session|token)|could not be refreshed|Invalid API key|API key.*(expired|invalid)|Please run .?\/login|not (logged in|authenticated)/i
const REPORT_CAP = 200_000
// Tools a launchd PATH doesn't include by default.
const EXTRA_PATH = [join(homedir(), ".local/bin"), join(homedir(), ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin"]

export type RunStatus = "ok" | "failed" | "blocked" | "timeout" | "error" | "auth"

function preamble(id: string, kind: string, createdBy: string, runs: string): string {
  return `You are running unattended on ${hostname().split(".")[0]} as scheduled job \`${id}\` (kind: ${kind}), queued by: ${createdBy}.
Nobody is watching this run and nobody can answer questions. Do the task below, then stop.
Rules: report, don't act. Do not modify files outside ${runs}, do not push, deploy, post to clients or email anyone, unless the task explicitly says to.
Your final message is the report. Start it with a line \`SUMMARY:\` followed by one short paragraph (under 600 characters, plain text) that stands on its own in a chat message. Then give the details in Markdown.
If you couldn't do the work because of something outside this job that a person has to fix (a lapsed login, a missing permission, a service refusing you), put a line \`STATUS: blocked\` straight after the summary and say what's needed. Don't use it for a finding, however bad.

--- TASK ---
`
}

// How to start this same SpinupTUI: the Bun running now plus its entry point, or
// just the executable when it's a compiled binary. Module jobs and `spinuptui`
// jobs use it, so they always run the dispatcher's own version.
export function selfCommand(): string[] {
  const compiled = Bun.main.startsWith("/$bunfs") || !/\bbun(\.exe)?$/.test(process.execPath)
  return compiled ? [process.execPath] : [process.execPath, Bun.main]
}

export function jobEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  const parts = (env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":")
  env.PATH = [...EXTRA_PATH.filter((p) => !parts.includes(p)), ...parts].join(":")
  // A job is not a dispatcher: a nested `scheduler tick` must refuse.
  delete env.SPINUPTUI_SCHEDULER_DISPATCHER
  return env
}

// Starts a process that outlives this one: its own session (launchd reaps a
// job's process group, not this), and no inherited pipes, since whoever reads
// this process's stdout would otherwise wait for the child to finish too.
export function spawnDetached(cmd: string[], opts: { cwd: string; env: Record<string, string> }): void {
  mkdirSync(opts.cwd, { recursive: true })
  const proc = spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true } as Parameters<typeof spawn>[1])
  proc.unref()
}

export interface ProcResult {
  code: number | null
  output: string
  timedOut: boolean
}

// Runs a command with stdout and stderr interleaved into one stream, in its own
// process group so a timeout can stop everything it started.
export async function runProcess(cmd: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<ProcResult> {
  const proc = spawn(["/bin/sh", "-c", 'exec "$@" 2>&1', "sh", ...cmd], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  } as Parameters<typeof spawn>[1])
  let timedOut = false
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, sig)
    } catch {
      // Already gone.
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill("SIGTERM")
    setTimeout(() => kill("SIGKILL"), 20_000).unref?.()
  }, opts.timeoutMs)
  const output = await new Response(proc.stdout as ReadableStream).text()
  const code = await proc.exited
  clearTimeout(timer)
  return { code: timedOut ? null : code, output, timedOut }
}

export function summaryOf(job: Job, output: string): string {
  const text = output.trim()
  if (agentOf(job.header)) {
    const m = text.match(/SUMMARY:\s*([\s\S]+?)(\n\s*\n|$)/)
    return (m ? m[1]! : text).trim().slice(0, 900)
  }
  if (job.header.kind === "spinuptui") {
    // A failed JSON result says what went wrong better than its tail does.
    const last = text.split("\n").reverse().find((l) => l.trim().startsWith("{"))
    if (last) {
      try {
        const r = JSON.parse(last) as { ok?: boolean; message?: string }
        if (r.ok === false && r.message) return r.message.slice(0, 900)
      } catch {
        // Not JSON; fall through to the tail.
      }
    }
  }
  return text.split("\n").slice(-15).join("\n").slice(-900)
}

export interface AgentRun {
  agent: "claude" | "codex"
  prompt: string
  workdir: string
  allow?: string
  addDirs?: string
  model?: string
  sandbox?: string
}

// The adapters: a binary name and how to build its argv. Scheduler's agent jobs
// and Sentinel's worker share them. Returns why it can't run, as a string.
export function agentCommand(run: AgentRun, env: Record<string, string>): string[] | string {
  const bin = Bun.which(run.agent, { PATH: env.PATH })
  if (!bin) return `${run.agent} not found on PATH`
  if (run.agent === "codex") return [bin, "exec", "-s", run.sandbox || "read-only", "-C", run.workdir, "--skip-git-repo-check", run.prompt]
  const cmd = [bin, "-p", run.prompt, "--output-format", "text", "--permission-mode", "default", "--allowedTools", run.allow || DEFAULT_ALLOW, "--disallowedTools", ALWAYS_DENY]
  for (const d of (run.addDirs ?? "").split(",")) if (d.trim()) cmd.push("--add-dir", expandHome(d.trim()))
  if (run.model) cmd.push("--model", run.model)
  return cmd
}

function buildCommand(job: Job, workdir: string, env: Record<string, string>, runs: string): string[] | string {
  const h = job.header
  const kind = h.kind!
  if (kind === "script") return ["/bin/bash", "-c", job.body]
  if (kind === "spinuptui") return [...selfCommand(), ...splitArgs(job.body)]
  const agent = agentOf(h)!
  const prompt = preamble(h.id!, agent === "codex" ? "agent/codex" : "agent/claude", h.created_by!, runs) + job.body
  return agentCommand({ agent, prompt, workdir, allow: h.allow, addDirs: h.add_dirs, model: h.model, sandbox: h.sandbox }, env)
}

// What a finished process means. An agent that exits 0 after saying it's blocked
// did no work, whatever its exit code says.
export function outcomeOf(agent: boolean, code: number | null, timedOut: boolean, output: string): RunStatus {
  if (agent && code !== 0 && AUTH_FAIL_RE.test(output)) return "auth"
  if (timedOut) return "timeout"
  if (code === 0) return agent && BLOCKED_RE.test(output) ? "blocked" : "ok"
  return !agent && code === BLOCKED_EXIT ? "blocked" : "failed"
}

export interface RunOutcome {
  status: RunStatus
  report?: string // source-relative
  notified?: "sent" | "skipped" | string // string = why it failed
}

const pad2 = (n: number) => String(n).padStart(2, "0")
const stamp = (d: Date) => fmt(d).replace(" ", "-").replace(":", "")
const duration = (s: number) => `${Math.floor(s / 60)}m ${pad2(s % 60)}s`

export async function runJob(source: Source, job: Job, occurrence: Date, now = new Date()): Promise<RunOutcome> {
  const h = job.header
  const id = h.id!
  const env = jobEnv()
  const workdir = expandHome(h.workdir || source.path)
  const timeoutMs = Number(h.timeout || DEFAULT_TIMEOUT_MIN) * 60_000
  const runs = join(runsDir(source), id)
  prepareWorkDir(runs)
  const reportRel = `runs/${id}/${stamp(now)}.md`

  const started = new Date()
  let status: RunStatus
  let code: number | null = null
  let output: string
  const cmd = existsSync(workdir) ? buildCommand(job, workdir, env, runs) : `workdir does not exist on this machine: ${workdir}`
  if (typeof cmd === "string") {
    status = "error"
    output = cmd
  } else {
    try {
      const r = await runProcess(cmd, { cwd: workdir, env, timeoutMs })
      code = r.code
      output = r.output
      status = outcomeOf(!!agentOf(h), r.code, r.timedOut, r.output)
      if (r.timedOut) output += `\n\n[scheduler] killed after ${timeoutMs / 60_000} minutes`
    } catch (err) {
      status = "error"
      output = `could not start: ${(err as Error).message}`
    }
  }
  return finish(source, job, occurrence, started, new Date(), status, code, output, reportRel)
}

async function finish(
  source: Source,
  job: Job,
  occurrence: Date,
  started: Date,
  finished: Date,
  status: RunStatus,
  code: number | null,
  output: string,
  reportRel: string,
): Promise<RunOutcome> {
  const h = job.header
  const id = h.id!
  const seconds = Math.round((finished.getTime() - started.getTime()) / 1000)
  const state = loadState(source, id)

  if (status === "auth") {
    // The agent isn't logged in, so nothing ran: no report. Retry in 30 minutes,
    // and page only once per scheduled slot.
    const agent = agentOf(h)!
    state.last_status = status
    state.retry_after = fmt(new Date(Date.now() + 30 * 60_000))
    const first = state.auth_alerted_for !== fmt(occurrence)
    state.auth_alerted_for = fmt(occurrence)
    saveState(source, id, state)
    if (!first) return { status, notified: "skipped" }
    const how = agent === "claude" ? "claude, then /login" : "codex login"
    const notified = await notify(
      `⚠️ Job ${id} did not run: the ${agent} login on ${hostname().split(".")[0]} has lapsed. Log in there (run \`${how}\`); it retries every 30 min until ${h.expires}.`,
      h.to,
    )
    return { status, notified }
  }

  if (output.length > REPORT_CAP) output = output.slice(0, REPORT_CAP) + `\n\n[scheduler] output truncated at ${REPORT_CAP} characters`
  const kindLabel = agentOf(h) ? `agent (${agentOf(h)})` : h.kind!
  writeFileSync(
    join(source.path, reportRel),
    `# ${id} — ${status}\n\n` +
      `- Scheduled: ${fmt(occurrence)}\n- Started: ${fmt(started)}:${pad2(started.getSeconds())}\n- Duration: ${duration(seconds)}\n` +
      `- Exit code: ${code ?? "None"}\n- Kind: ${kindLabel}\n- Job file: jobs/${id}.md\n- Queued by: ${h.created_by}\n\n---\n\n` +
      output.trimEnd() +
      "\n",
  )
  state.last_status = status
  state.last_report = reportRel
  delete state.retry_after
  delete state.auth_alerted_for
  state.runs = (state.runs ?? 0) + 1
  state.last_run = fmt(started)
  state.last_scheduled = fmt(occurrence)
  saveState(source, id, state)

  let notified: RunOutcome["notified"] = "skipped"
  if ((h.notify || "beacon") !== "none") {
    const icon = { ok: "✅", failed: "❌", blocked: "🚧", timeout: "⏱️", error: "❌" }[status as Exclude<RunStatus, "auth">] ?? "•"
    notified = await notify(
      `${icon} Job ${id} (${status}, ${duration(seconds)})\n\n${summaryOf(job, output) || "(no output)"}\n\nReport: ${source.name}/${reportRel}\nQueued by: ${h.created_by}`,
      h.to,
      status === "ok" ? undefined : [[runAgainButton(source.name, id)]],
    )
  }
  return { status, report: reportRel, notified }
}

// A tap re-runs the job exactly as written: it can't add permissions.
export function runAgainButton(source: string, id: string): BeaconButton {
  return { text: `Run ${id} again`, action: "scheduler.run", payload: { source, id } }
}

// In-process Beacon send. Never throws; returns "sent" or why it wasn't.
export async function notify(text: string, to?: string, buttons?: BeaconButton[][], silent = false): Promise<string> {
  try {
    const r = await beaconSend(beaconFromConfig(loadConfig()), text, { to: to || null, silent, ...(buttons ? { replyMarkup: pageMarkup(buttons) } : {}) })
    return r.ok ? "sent" : `${r.reason}: ${r.message}`
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

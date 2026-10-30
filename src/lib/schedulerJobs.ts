// Scheduler's user follow-ups: job files, sources and per-job state.
//
// A source is a directory holding jobs/ and runs/. The built-in `local` source is
// Scheduler's own state directory; named sources are directories the user adds
// (git repositories are pulled and pushed by the tick). The job-file format and
// the runs/ layout are the git-backed job runner's, unchanged, so a source can
// move between dispatchers without conversion (docs/2026-10-20_scheduler-spec.md).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { AppConfig } from "../config.ts"
import { moduleStateDir, moduleWorkDir } from "../modules/contract.ts"
import { parseDate, parseEvery, parseWhen, type ScheduleState } from "./schedule.ts"

export const KINDS = ["spinuptui", "script", "agent", "codex"] as const
export type JobKind = (typeof KINDS)[number]
export const AGENTS = ["claude", "codex"] as const
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/
const REQUIRED = ["id", "kind", "expires", "created_by"] as const
export const DEFAULT_TIMEOUT_MIN = 30

// ---- sources --------------------------------------------------------------------

export interface Source {
  name: string
  path: string
  // The git repository the source is in (its own .git or a parent's), if any.
  // `~/SpinupTUI/` made into a repository turns `local` into a git source.
  gitRoot: string | null
  git: boolean
  // This machine queues to it but never claims or runs it (`source release`).
  queueOnly: boolean
}

export const LOCAL_SOURCE = "local"

export function schedulerStateDir(): string {
  return moduleStateDir("scheduler")
}

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p
}

// The nearest directory at or above `path` holding .git, stopping below the
// home directory and the filesystem root (a dotfiles repo in ~ shouldn't turn
// every folder into a git source).
export function gitRootOf(path: string): string | null {
  const home = homedir()
  let dir = path
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir
    const up = dirname(dir)
    if (up === dir || up === home || dir === home) return null
    dir = up
  }
}

function makeSource(cfg: AppConfig, name: string, path: string): Source {
  const gitRoot = gitRootOf(path)
  return { name, path, gitRoot, git: gitRoot !== null, queueOnly: (cfg.scheduler?.queueOnly ?? []).includes(name) }
}

export function listSources(cfg: AppConfig): Source[] {
  const out: Source[] = [makeSource(cfg, LOCAL_SOURCE, moduleWorkDir("scheduler"))]
  for (const [name, s] of Object.entries(cfg.scheduler?.sources ?? {})) out.push(makeSource(cfg, name, expandHome(s.path)))
  return out
}

export function defaultSourceName(cfg: AppConfig): string {
  const d = cfg.scheduler?.defaultSource
  return d && cfg.scheduler?.sources?.[d] ? d : LOCAL_SOURCE
}

export function findSource(cfg: AppConfig, name: string | null | undefined): Source | null {
  const want = name || defaultSourceName(cfg)
  return listSources(cfg).find((s) => s.name === want) ?? null
}

export const jobsDir = (s: Source) => join(s.path, "jobs")
export const runsDir = (s: Source) => join(s.path, "runs")
// A named source's lock is the existing job runner's own lock file, so the two
// serialize during a cutover. The local source's lives with the machine state,
// keeping ~/SpinupTUI/ to jobs and reports.
export const sourceLockPath = (s: Source) =>
  s.name === LOCAL_SOURCE ? join(schedulerStateDir(), "local-source.lock") : join(s.path, ".state", "dispatch.lock")
// Which station runs this (git) source: one short hostname.
export const claimPath = (s: Source) => join(s.path, ".scheduler", "station")

// ---- job files ------------------------------------------------------------------

export type JobHeader = Record<string, string>

export interface Job {
  name: string // file name
  header: JobHeader
  body: string
  problems: string[]
}

export function parseJobText(text: string): { header: JobHeader; body: string } {
  const lines = text.split("\n")
  if (lines[0]?.trim() !== "---") throw new Error("must start with a '---' header line")
  const header: JobHeader = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "---") return { header, body: lines.slice(i + 1).join("\n").trim() }
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const colon = line.indexOf(":")
    if (colon === -1) throw new Error(`header line without ':': "${line}"`)
    // Trailing " # comment"s are allowed.
    header[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).split(" #")[0]!.trim()
  }
  throw new Error("header is not closed with '---'")
}

export function validateJob(header: JobHeader, body: string, filename?: string): string[] {
  const problems: string[] = []
  for (const key of REQUIRED) if (!header[key]) problems.push(`missing ${key}:`)
  const id = header.id ?? ""
  if (id && !ID_RE.test(id)) problems.push("id must be lowercase letters, digits and hyphens")
  if (filename && id && filename !== `${id}.md`) problems.push(`file must be named ${id}.md`)
  if (header.kind && !(KINDS as readonly string[]).includes(header.kind)) problems.push(`kind must be one of ${KINDS.join(", ")}`)
  if (header.agent && !(AGENTS as readonly string[]).includes(header.agent)) problems.push(`agent must be one of ${AGENTS.join(", ")}`)
  if (!!header.when === !!header.every) problems.push("give exactly one of when: or every:")
  try {
    if (header.when) parseWhen(header.when)
    if (header.every) parseEvery(header.every)
    if (header.expires) parseDate(header.expires)
    if (header.created) parseWhen(header.created)
  } catch (err) {
    problems.push((err as Error).message)
  }
  if (header.timeout && !/^\d+$/.test(header.timeout)) problems.push("timeout: is whole minutes")
  if (header.notify && !["beacon", "telegram", "none"].includes(header.notify)) problems.push("notify: is beacon or none")
  if (header.late && lateGraceMs(header.late) === undefined) problems.push("late: is run, skip, or a grace window like 30m or 2h")
  if (!body) problems.push("the body (command, prompt or script) is empty")
  if (header.kind === "spinuptui" && body) {
    try {
      const args = splitArgs(body)
      if (args[0] === "scheduler") problems.push("a spinuptui job can't run `scheduler` (a job may not start a tick)")
    } catch (err) {
      problems.push((err as Error).message)
    }
  }
  return problems
}

export function loadJobs(source: Source): Job[] {
  const dir = jobsDir(source)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((name) => {
      try {
        const { header, body } = parseJobText(readFileSync(join(dir, name), "utf8"))
        return { name, header, body, problems: validateJob(header, body, name) }
      } catch (err) {
        return { name, header: {}, body: "", problems: [(err as Error).message] }
      }
    })
}

export function renderJob(header: [string, string][], body: string): string {
  return "---\n" + header.map(([k, v]) => `${k}: ${v}\n`).join("") + "---\n" + body.trim() + "\n"
}

// `late:` as a grace window in ms: null = run whenever reached (the default),
// undefined = not a valid value.
export const LATE_SKIP_GRACE_MS = 15 * 60_000
export function lateGraceMs(value: string | undefined): number | null | undefined {
  const v = (value ?? "run").trim().toLowerCase()
  if (v === "run") return null
  if (v === "skip") return LATE_SKIP_GRACE_MS
  const m = v.match(/^(\d+)\s*([mh])$/)
  if (!m || +m[1]! === 0) return undefined
  return +m[1]! * (m[2] === "h" ? 3_600_000 : 60_000)
}

// The effective kind and agent: `kind: codex` is the older spelling of
// `kind: agent` + `agent: codex`.
export function agentOf(header: JobHeader): "claude" | "codex" | null {
  if (header.kind === "codex") return "codex"
  if (header.kind === "agent") return header.agent === "codex" ? "codex" : "claude"
  return null
}

// ---- state ----------------------------------------------------------------------

export interface JobState extends ScheduleState {
  runs?: number
  last_report?: string
  auth_alerted_for?: string
  invalid?: string
}

export const statePath = (s: Source, id: string) => join(runsDir(s), id, "state.json")

export function loadState(s: Source, id: string): JobState {
  try {
    return JSON.parse(readFileSync(statePath(s, id), "utf8")) as JobState
  } catch {
    return {}
  }
}

// Sorted keys and a trailing newline, as the prior art writes it, so a cutover
// doesn't produce a noisy diff in the source's history.
export function saveState(s: Source, id: string, state: JobState): void {
  mkdirSync(join(runsDir(s), id), { recursive: true })
  const sorted = Object.fromEntries(Object.entries(state).sort(([a], [b]) => (a < b ? -1 : 1)))
  const path = statePath(s, id)
  writeFileSync(`${path}.tmp`, JSON.stringify(sorted, null, 2) + "\n")
  renameSync(`${path}.tmp`, path)
}

// ---- the tick record ---------------------------------------------------------------

export interface TickRun {
  source: string
  id: string
  status: "ok" | "failed" | "blocked" | "timeout" | "error" | "auth" | "invalid" | "skipped"
  report?: string
  notified?: string
}

export interface TickRecord {
  at: string // ISO
  via: "dispatcher" | "manual"
  durationMs: number
  ran: TickRun[]
  errors: string[]
  // Git sources another station runs (or released here): expected, not errors.
  notRunHere?: string[]
  // This dispatcher tick found the previous one still running, so it did nothing
  // but say the station is alive.
  stillRunning?: boolean
  // The station heartbeat's ping at the end of this tick, when one is set.
  heartbeat?: { ok: boolean; status: "up" | "down"; error?: string }
}

export const lastTickPath = () => join(schedulerStateDir(), "last-tick.json")
export const tickLogPath = () => join(schedulerStateDir(), "tick.log")

export function readLastTick(): TickRecord | null {
  try {
    return JSON.parse(readFileSync(lastTickPath(), "utf8")) as TickRecord
  } catch {
    return null
  }
}

// ---- argument splitting -----------------------------------------------------------

// Split a `spinuptui` job's body into argv the way a shell would — single and
// double quotes, backslash escapes — without any expansion. Newlines are
// whitespace, so a long command can wrap.
export function splitArgs(text: string): string[] {
  const out: string[] = []
  let cur = ""
  let has = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
    } else if (quote === '"') {
      if (c === '"') quote = null
      else if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) cur += text[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      quote = c
      has = true
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ""
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (quote) throw new Error("unclosed quote in the command")
  if (has || cur) out.push(cur)
  return out
}

// Sentinel's machine state and the shape of an incident
// (docs/2026-10-30_sentinel-spec.md). Everything here lives in the module's state
// directory and is replaced atomically, so the tick, the worker and the listener
// can each write without sharing a mutable file: one file per incident.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AppConfig } from "../config.ts"
import { moduleStateDir, moduleWorkDir } from "../modules/contract.ts"
import type { IncidentKind } from "./cliIncidents.ts"
import { expandHome } from "./schedulerJobs.ts"

export const DEFAULT_ALLOW = "Read,Grep,Glob,Edit(sites/**),Write(sites/**),Bash(spinuptui ssh-exec *),Bash(spinuptui siblings *),Bash(spinuptui incidents *)"
const LOG_MAX_BYTES = 1_000_000
export const INCIDENT_KEEP_DAYS = 30
export const SEEN_KEEP_DAYS = 8

export interface SentinelSettings {
  enabled: boolean
  shadow: boolean
  channel: string | null
  reportTo: string | null
  workspace: string
  recurrenceHours: number
  maxDiagnosesPerDay: number
  agent: "claude" | "codex" | null
  model: string | null
  timeoutMin: number
  allow: string
}

export function sentinelSettings(cfg: AppConfig): SentinelSettings {
  const s = cfg.sentinel ?? {}
  return {
    enabled: !!s.enabled,
    shadow: s.mode === "shadow",
    channel: s.channel ?? null,
    reportTo: s.reportTo ?? null,
    workspace: s.workspace ? expandHome(s.workspace) : moduleWorkDir("sentinel"),
    recurrenceHours: s.recurrenceHours ?? 6,
    maxDiagnosesPerDay: s.maxDiagnosesPerDay ?? 15,
    agent: s.diagnosis?.agent ?? null,
    model: s.diagnosis?.model ?? null,
    timeoutMin: s.diagnosis?.timeoutMin ?? 30,
    allow: s.diagnosis?.allow ? `${DEFAULT_ALLOW},${s.diagnosis.allow}` : DEFAULT_ALLOW,
  }
}

export const sentinelDir = () => moduleStateDir("sentinel")
export const incidentsDir = () => join(sentinelDir(), "incidents")
export const transcriptsDir = () => join(sentinelDir(), "transcripts")
export const workerLockPath = () => join(sentinelDir(), "worker.lock")
export const expectationsPath = () => join(moduleWorkDir("sentinel"), "expectations.json")
export const trendsPath = () => join(moduleWorkDir("sentinel"), "trends.csv")
const statePath = (name: string) => join(sentinelDir(), name)

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

// ---- incidents -----------------------------------------------------------------------

export type IncidentState =
  | "queued"
  | "diagnosing"
  | "reported"
  | "waiting_agent" // the login lapsed: pages once, retries, drains when it's back
  | "blocked" // the agent couldn't do the work
  | "failed" // after two attempts
  | "recurrence" // covered by an earlier report; no diagnosis
  | "shadow" // shadow mode: what would have been queued

export interface IncidentEvent {
  domain: string
  kind: IncidentKind
  time: string
  message: string
  monitorId: number
}

export interface Incident {
  id: string
  key: string // what groups it: the server's name, or the domain if unknown
  server: string | null
  state: IncidentState
  createdAt: string
  events: IncidentEvent[]
  down: number[] // monitors still down
  lastDownAt: string
  closedAt?: string
  attempts: number
  startedAt?: string
  retryAfter?: string
  why?: string // blocked or failed: what's needed
  refersTo?: string // a recurrence's earlier incident
  evidence?: string
  site?: string // the site the report is filed under
  reportPath?: string
  reportedAt?: string
  summary?: string
  // Basecamp has no idempotency key: "posting" with no id means the outcome is
  // unknown, and nothing may repost it automatically.
  post?: "posting" | "posted" | "failed" | "unknown"
  postId?: string
  postUrl?: string
  postError?: string
}

const incidentPath = (id: string) => join(incidentsDir(), `${id}.json`)

export function saveIncident(i: Incident): void {
  writeJson(incidentPath(i.id), i)
}

export function loadIncident(id: string): Incident | null {
  return readJson<Incident | null>(incidentPath(id), null)
}

export function deleteIncident(id: string): void {
  try {
    unlinkSync(incidentPath(id))
  } catch {
    // Already gone.
  }
}

export function loadIncidents(): Incident[] {
  if (!existsSync(incidentsDir())) return []
  const out: Incident[] = []
  for (const f of readdirSync(incidentsDir())) {
    if (!f.endsWith(".json")) continue
    const i = readJson<Incident | null>(join(incidentsDir(), f), null)
    if (i) out.push(i)
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export const isWaiting = (i: Incident) => ["queued", "diagnosing", "waiting_agent", "blocked", "failed"].includes(i.state)

// ---- the tick's own record ---------------------------------------------------------

export interface TickState {
  // Set by the first tick, which marks history as seen rather than paging for it.
  started?: boolean
  lastCleanAt?: string
  lastTickAt?: string
  lastError?: string
  blindSince?: string
  // Paged once each until the condition clears.
  authPagedAt?: string
  capPagedFor?: string
}

export const loadTickState = () => readJson<TickState>(statePath("tick-state.json"), {})
export const saveTickState = (s: TickState) => writeJson(statePath("tick-state.json"), s)

export type Seen = Record<string, string>
export const seenKey = (e: { monitorId: number; time: string; domain: string }) => `${e.monitorId}|${e.time}|${e.domain}`
export const loadSeen = () => readJson<Seen>(statePath("seen.json"), {})
export const saveSeen = (s: Seen) => writeJson(statePath("seen.json"), s)

export interface PauseState {
  until: string
  events?: number
}
export const loadPause = () => readJson<PauseState | null>(statePath("pause.json"), null)
export const savePause = (p: PauseState) => writeJson(statePath("pause.json"), p)
export function clearPause(): void {
  try {
    unlinkSync(statePath("pause.json"))
  } catch {
    // Not paused.
  }
}

export interface FlagRecord {
  firstSeen: string // YYYY-MM-DD
  text: string
  acked?: boolean
}
export type Flags = Record<string, FlagRecord>
export const loadFlags = () => readJson<Flags>(statePath("flags.json"), {})
export const saveFlags = (f: Flags) => writeJson(statePath("flags.json"), f)

export interface FleetEntry {
  server: string
  site: string // the site's primary domain
  vanity?: boolean
}
export interface Fleet {
  fetchedAt?: string
  domains: Record<string, FleetEntry>
}
export const loadFleet = () => readJson<Fleet>(statePath("fleet.json"), { domains: {} })
export const saveFleet = (f: Fleet) => writeJson(statePath("fleet.json"), f)

// ---- logs ----------------------------------------------------------------------------

function appendLine(name: string, line: string): void {
  try {
    mkdirSync(sentinelDir(), { recursive: true })
    const path = statePath(name)
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`)
    appendFileSync(path, line + "\n", { mode: 0o600 })
  } catch {
    // A log line must never fail a tick.
  }
}

export interface TickLine {
  at: string
  ok: boolean
  events: number
  incidents: number
  retries: number
  error?: string
}

export const logTick = (line: TickLine) => appendLine("tick.log", JSON.stringify(line))
export const logShadow = (line: string) => appendLine("shadow.log", `${new Date().toISOString()} ${line}`)

export function readTickLog(sinceMs: number): TickLine[] {
  const out: TickLine[] = []
  for (const name of ["tick.log.1", "tick.log"]) {
    try {
      for (const l of readFileSync(statePath(name), "utf8").split("\n")) {
        if (!l) continue
        const t = JSON.parse(l) as TickLine
        if (Date.parse(t.at) >= sinceMs) out.push(t)
      }
    } catch {
      // Not there yet.
    }
  }
  return out
}

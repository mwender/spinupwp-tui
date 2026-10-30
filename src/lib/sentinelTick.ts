// One Sentinel tick: seconds of work, run every 5 minutes by Scheduler. It reads
// Kuma's events, decides what's new, pages, and starts the worker for anything
// slow. Nothing here may block on an agent: module jobs are killed at 10 minutes,
// ticks are exclusive, and the worker is what makes that a non-issue
// (docs/2026-10-30_sentinel-spec.md, "The tick").

import type { AppConfig } from "../config.ts"
import type { SpinupWPClientLike } from "../api/client.ts"
import { beaconFromConfig, beaconSend } from "./beacon.ts"
import { pageMarkup } from "./beaconListenInstall.ts"
import { resolveIncidents, type IncidentsResult } from "./cliIncidents.ts"
import { tryLock } from "./flock.ts"
import { jobEnv, selfCommand, spawnDetached } from "./schedulerRun.ts"
import { applyEvents, closeIncidents, markSeen, newEvents, startedToday, windowHours, type Page } from "./sentinelIncidents.ts"
import {
  clearPause,
  INCIDENT_KEEP_DAYS,
  deleteIncident,
  loadFleet,
  loadIncidents,
  loadPause,
  loadSeen,
  loadTickState,
  logShadow,
  logTick,
  saveFleet,
  saveIncident,
  savePause,
  saveSeen,
  saveTickState,
  sentinelDir,
  workerLockPath,
  type Fleet,
  type Incident,
  type SentinelSettings,
} from "./sentinelState.ts"
import { existsSync } from "node:fs"

export const KUMA_RETRIES = 2
export const KUMA_RETRY_DELAY_MS = 60_000
const FLEET_REFRESH_MS = 60 * 60_000
const WAITING_RETRY_MS = 30 * 60_000
const MAX_ATTEMPTS = 2

export interface TickDeps {
  incidents(hours: number): Promise<IncidentsResult>
  page(p: Page, channel: string | null): Promise<string>
  refreshFleet(): Promise<Fleet | null>
  startWorker(): void
  workerRunning(): boolean
  sleep(ms: number): Promise<unknown>
  now(): Date
}

export type TickOutcome =
  | { ok: true; events: number; incidents: number; started: boolean; paused?: boolean; firstRun?: boolean; shadow?: boolean }
  | { ok: false; reason: string; message: string; needsPerson: boolean }

export async function refreshFleetFrom(client: SpinupWPClientLike, now: Date): Promise<Fleet> {
  const [servers, sites] = await Promise.all([client.listServers(), client.listSites()])
  const names = new Map(servers.map((s) => [s.id, s.name]))
  const domains: Fleet["domains"] = {}
  for (const site of sites) {
    const server = names.get(site.server_id) ?? `server ${site.server_id}`
    domains[site.domain] = { server, site: site.domain }
    for (const d of site.additional_domains ?? []) domains[d.domain] = { server, site: site.domain }
  }
  // A server's vanity host answers to the server's own name.
  for (const name of names.values()) if (domains[name]) domains[name] = { ...domains[name]!, vanity: true }
  return { fetchedAt: now.toISOString(), domains }
}

export function realDeps(cfg: AppConfig, client: SpinupWPClientLike): TickDeps {
  return {
    incidents: (hours) => resolveIncidents(cfg, { hours, wiring: true }),
    page: (p, channel) => sendPage(cfg, p, channel),
    refreshFleet: async () => {
      try {
        return await refreshFleetFrom(client, new Date())
      } catch {
        return null
      }
    },
    startWorker: () => spawnDetached([...selfCommand(), "sentinel", "worker"], { cwd: sentinelDir(), env: jobEnv() }),
    workerRunning: () => {
      if (!existsSync(workerLockPath())) return false
      const lock = tryLock(workerLockPath())
      if (!lock) return true
      lock.release()
      return false
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  }
}

// Never throws: a page that can't go out mustn't stop the tick that would retry it.
export async function sendPage(cfg: AppConfig, p: Page, channel: string | null): Promise<string> {
  try {
    const r = await beaconSend(beaconFromConfig(cfg), p.text, { to: channel, silent: p.silent, ...(p.buttons ? { replyMarkup: pageMarkup(p.buttons) } : {}) })
    return r.ok ? "sent" : `${r.reason}: ${r.message}`
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
}

async function readEvents(deps: TickDeps, hours: number): Promise<{ result: IncidentsResult; retries: number }> {
  let result = await deps.incidents(hours)
  let retries = 0
  // A tick straight after a wake reaches Kuma before the network is back, so a
  // failure isn't believed until it has repeated. Retrying can't fix configuration.
  while (!result.ok && result.reason === "kuma_error" && retries < KUMA_RETRIES) {
    retries++
    await deps.sleep(KUMA_RETRY_DELAY_MS)
    result = await deps.incidents(hours)
  }
  return { result, retries }
}

// Requeues what a dead worker left behind and what's due another try. Runs on
// every tick, so nothing waits on a person remembering.
function reviveWork(incidents: Incident[], deps: TickDeps, now: Date): { changed: Incident[]; pages: Page[] } {
  const changed: Incident[] = []
  const pages: Page[] = []
  const worker = deps.workerRunning()
  for (const i of incidents) {
    if (i.state === "diagnosing" && !worker) {
      if (i.attempts >= MAX_ATTEMPTS) {
        i.state = "failed"
        i.why = "the worker stopped mid-diagnosis, twice"
        pages.push({ text: `❌ ${i.id}: ${i.why}.`, silent: false, buttons: [[{ text: "Run again", action: "sentinel.diagnose", payload: { id: i.id } }]] })
      } else i.state = "queued"
      changed.push(i)
    } else if (i.state === "waiting_agent" && i.retryAfter && now.getTime() >= Date.parse(i.retryAfter)) {
      i.state = "queued"
      delete i.retryAfter
      changed.push(i)
    } else if (i.post === "posting" && !worker) {
      i.post = "unknown"
      changed.push(i)
      pages.push({ text: `⚠️ ${i.id}: the worker stopped while posting to the board, so the post may or may not exist. It won't be retried automatically; check the board, then run spinuptui sentinel post ${i.id} if it's missing.`, silent: false })
    }
  }
  return { changed, pages }
}

function prune(incidents: Incident[], now: Date): void {
  const cutoff = now.getTime() - INCIDENT_KEEP_DAYS * 24 * 3_600_000
  for (const i of incidents) if (i.closedAt && Date.parse(i.closedAt) < cutoff) deleteIncident(i.id)
}

export interface TickOptions {
  dryRun?: boolean
}

export async function sentinelTick(s: SentinelSettings, deps: TickDeps, opts: TickOptions = {}): Promise<TickOutcome> {
  const now = deps.now()
  const nowIso = now.toISOString()
  const tickState = loadTickState()
  const pause = loadPause()
  const { result, retries } = await readEvents(deps, windowHours(tickState.lastCleanAt, now))

  if (!result.ok) {
    if (opts.dryRun) return { ok: false, reason: result.reason, message: result.message, needsPerson: false }
    logTick({ at: nowIso, ok: false, events: 0, incidents: 0, retries, error: result.message })
    saveTickState({ ...tickState, lastTickAt: nowIso, lastError: result.message, blindSince: tickState.blindSince ?? nowIso })
    if (s.shadow) {
      logShadow(`would report blind: ${result.message}`)
      return { ok: true, events: 0, incidents: 0, started: false, shadow: true }
    }
    // Diagnosis doesn't need Kuma, so being blind doesn't hold up what's queued.
    const incidents = loadIncidents()
    if (incidents.some((i) => i.state === "queued") && startedToday(incidents, now) < s.maxDiagnosesPerDay && !deps.workerRunning()) deps.startWorker()
    // Exiting non-zero is the page: Scheduler says so once, and again on recovery.
    return { ok: false, reason: result.reason, message: `Sentinel can't read Uptime Kuma, so it's blind: ${result.message}`, needsPerson: result.reason !== "kuma_error" }
  }

  const seen = loadSeen()
  const fresh = newEvents(result.events, seen)
  const clean = result.failedMonitors.length === 0
  const nextTickState = {
    ...tickState,
    lastTickAt: nowIso,
    lastError: clean ? undefined : `couldn't read ${result.failedMonitors.join(", ")}`,
    blindSince: undefined,
    started: true,
    // A monitor that failed to read isn't covered yet, so the window stays open
    // for it and the seen-set stops anything repeating.
    ...(clean ? { lastCleanAt: nowIso } : {}),
  }

  if (opts.dryRun) {
    const plan = applyEvents({ incidents: structuredClone(loadIncidents()), events: fresh, fleet: loadFleet(), now, recurrenceHours: s.recurrenceHours, hasAgent: !!s.agent, shadow: s.shadow, kumaAlerted: new Set(result.kumaAlerted) })
    for (const p of plan.pages) process.stderr.write(`would page${p.silent ? " (silent)" : ""}: ${p.text}\n`)
    return { ok: true, events: fresh.length, incidents: plan.created.length, started: false }
  }

  // The first tick starts from now: history isn't news.
  if (!tickState.started) {
    saveSeen(markSeen(seen, result.events, now))
    saveTickState(nextTickState)
    logTick({ at: nowIso, ok: true, events: 0, incidents: 0, retries })
    return { ok: true, events: result.events.length, incidents: 0, started: false, firstRun: true }
  }

  let incidents = loadIncidents()
  const pages: Page[] = []

  // A pause that's over says so once, wherever it ended up.
  const paused = pause && now.getTime() < Date.parse(pause.until) ? pause : null
  if (pause && !paused) {
    clearPause()
    pages.push({ text: `▶️ Sentinel is watching again. ${pause.events ?? 0} event(s) passed during the pause and weren't acted on.`, silent: true })
  }

  let fleet = loadFleet()
  const stale = !fleet.fetchedAt || now.getTime() - Date.parse(fleet.fetchedAt) > FLEET_REFRESH_MS
  const hasUnknown = fresh.some((e) => e.status === "down" && !fleet.domains[e.domain])
  if (hasUnknown && stale) {
    const r = await deps.refreshFleet()
    if (r) {
      fleet = r
      saveFleet(r)
    }
  }

  const relevant = paused ? fresh.filter((e) => e.status === "up") : fresh
  const applied = applyEvents({ incidents, events: relevant, fleet, now, recurrenceHours: s.recurrenceHours, hasAgent: !!s.agent, shadow: s.shadow, kumaAlerted: new Set(result.kumaAlerted) })
  incidents = [...incidents, ...applied.created]
  pages.push(...applied.pages)
  if (paused && fresh.length) savePause({ ...paused, events: (paused.events ?? 0) + (fresh.length - relevant.length) })

  const revived = s.shadow ? { changed: [], pages: [] } : reviveWork(incidents, deps, now)
  pages.push(...revived.pages)
  const closed = closeIncidents(incidents, now)

  // Incidents before the seen-set: if this tick dies between the two, the events
  // come round again and the open incident absorbs them, rather than being lost.
  for (const i of new Set([...applied.changed, ...revived.changed, ...closed])) saveIncident(i)
  saveSeen(markSeen(seen, fresh, now))

  const queued = incidents.filter((i) => i.state === "queued")
  const atCap = queued.length > 0 && startedToday(incidents, now) >= s.maxDiagnosesPerDay
  const day = now.toLocaleDateString("en-CA")
  if (atCap && nextTickState.capPagedFor !== day) {
    nextTickState.capPagedFor = day
    pages.push({ text: `⏸ Sentinel has reached today's limit of ${s.maxDiagnosesPerDay} diagnoses; ${queued.length} waiting. They start tomorrow, or raise sentinel.maxDiagnosesPerDay.`, silent: false })
  }
  const started = queued.length > 0 && !atCap && !s.shadow && !deps.workerRunning()

  if (s.shadow) for (const p of pages) logShadow(`would page${p.silent ? " (silent)" : ""}: ${p.text}`)
  else for (const p of pages) await deps.page(p, s.channel)
  if (started) deps.startWorker()

  saveTickState(nextTickState)
  logTick({ at: nowIso, ok: true, events: fresh.length, incidents: applied.created.length, retries, ...(clean ? {} : { error: nextTickState.lastError }) })
  prune(incidents, now)
  return { ok: true, events: fresh.length, incidents: applied.created.length, started, ...(paused ? { paused: true } : {}), ...(s.shadow ? { shadow: true } : {}) }
}

export function nextRetryAt(now: Date): string {
  return new Date(now.getTime() + WAITING_RETRY_MS).toISOString()
}

export { MAX_ATTEMPTS }

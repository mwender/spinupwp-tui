// Sentinel's module declaration: watches the fleet, works out what broke, writes
// it up. Its status is cheap and sends nothing: Scheduler asks every tick.

import { existsSync } from "node:fs"
import { listProfiles, loadConfig } from "../config.ts"
import { beaconFromConfig, escapeHtml } from "../lib/beacon.ts"
import { hasIncidentMonitors } from "../lib/cliIncidents.ts"
import { waitingRows } from "../lib/sentinelReply.ts"
import { isWaiting, loadIncident, loadIncidents, loadPause, loadTickState, saveIncident, sentinelSettings } from "../lib/sentinelState.ts"
import { moduleStateDir, moduleWorkDir, type BeaconReply, type ModuleCheck, type ModuleDefinition, type ModuleStatus } from "./contract.ts"

const TICK_STALE_MS = 15 * 60_000
const STUCK_MS = 24 * 60 * 60_000

export const sentinelModule: ModuleDefinition = {
  id: "sentinel",
  name: "Sentinel",
  summary: "Watches the fleet, works out what actually broke, and writes it up.",
  dependsOn: ["beacon", "scheduler"],
  configKey: "sentinel",
  stateDir: () => moduleStateDir("sentinel"),
  workDir: () => moduleWorkDir("sentinel"),
  jobs: [
    { id: "sentinel.tick", every: "5m", command: ["sentinel", "tick"] },
    { id: "sentinel.digest", at: "08:00", command: ["sentinel", "digest"] },
  ],
  commands: [{ command: "incidents", describe: "open incidents and anything waiting on you", run: () => incidentsReply() }],
  actions: [{ action: "sentinel.diagnose", run: (payload) => diagnoseReply(payload) }],
  async status(): Promise<ModuleStatus> {
    const cfg = loadConfig()
    const s = sentinelSettings(cfg)
    if (!s.enabled) {
      return { id: "sentinel", state: "not_configured", summary: "Not set up", checks: [], remedy: "spinuptui sentinel setup --plan" }
    }
    const checks: ModuleCheck[] = []
    const domains = Object.entries(cfg.kumaMonitors).filter(([, r]) => hasIncidentMonitors(r)).length
    checks.push({ name: "watching", ok: domains > 0, detail: domains ? `${domains} domain${domains === 1 ? "" : "s"}` : "no monitors registered: run spinuptui sentinel attach --plan" })
    const t = loadTickState()
    const age = t.lastTickAt ? Date.now() - Date.parse(t.lastTickAt) : null
    const stale = age === null || age > TICK_STALE_MS
    checks.push({
      name: "last tick",
      ok: !t.blindSince && !stale,
      detail: t.blindSince ? `blind since ${t.blindSince}: ${t.lastError}` : age === null ? "none yet" : `${Math.round(age / 60_000)} min ago${t.lastError ? ` (${t.lastError})` : ""}`,
    })
    const incidents = loadIncidents()
    const now = Date.now()
    const waiting = incidents.filter(isWaiting)
    const stuck = waiting.filter((i) => now - Date.parse(i.createdAt) > STUCK_MS)
    const count = (state: string) => waiting.filter((i) => i.state === state).length
    const queue = [["queued", count("queued")], ["diagnosing", count("diagnosing")], ["waiting on login", count("waiting_agent")], ["blocked", count("blocked")], ["failed", count("failed")]].filter(([, n]) => n)
    checks.push({ name: "queue", ok: stuck.length === 0, detail: queue.length ? queue.map(([k, n]) => `${n} ${k}`).join(", ") : "empty" })
    const agentBin = s.agent ? Bun.which(s.agent, { PATH: `${process.env.HOME}/.local/bin:${process.env.HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` }) : null
    checks.push({ name: "agent", ok: !s.agent || !!agentBin, detail: !s.agent ? "none: incidents get a write-up of the evidence, not a diagnosis" : agentBin ? s.agent : `${s.agent} isn't on the PATH` })
    checks.push({ name: "beacon", ok: beaconFromConfig(cfg).channels.length > 0, detail: s.channel ?? "default channel" })
    if (s.reportTo) checks.push({ name: "board", ok: !!cfg.beacon?.boards?.[s.reportTo], detail: cfg.beacon?.boards?.[s.reportTo] ? s.reportTo : `no Beacon board named ${s.reportTo}` })
    const pause = loadPause()
    const paused = pause && Date.parse(pause.until) > now
    checks.push({ name: "mode", ok: true, detail: paused ? `paused until ${new Date(pause.until).toLocaleString()}` : s.shadow ? "shadow: pages nothing, runs no agent" : "live" })
    checks.push({ name: "workspace", ok: existsSync(s.workspace) || s.workspace === moduleWorkDir("sentinel"), detail: s.workspace })
    const others = listProfiles().filter((p) => !p.active).length
    if (others) checks.push({ name: "accounts", ok: true, detail: `watching the active account only; ${others} other account${others === 1 ? " is" : "s are"} not covered` })
    const failing = checks.find((c) => !c.ok)
    return {
      id: "sentinel",
      state: failing ? "degraded" : "ok",
      summary: failing ? `${failing.name}: ${failing.detail}` : paused ? "paused" : s.shadow ? `shadow, ${domains} domains` : `watching ${domains} domain${domains === 1 ? "" : "s"}`,
      checks,
      ...(failing ? { remedy: failing.name === "watching" ? "spinuptui sentinel attach --plan" : "spinuptui sentinel status" } : {}),
    }
  },
}

export async function incidentsReply(): Promise<BeaconReply> {
  const rows = waitingRows(loadIncidents())
  if (!rows.length) return { text: "No open incidents." }
  const text = [`<b>Incidents</b> (${rows.length})`, ...rows.map((r) => escapeHtml(r.line))].join("\n\n")
  const buttons = rows.filter((r) => r.button).map((r) => [r.button!])
  return { text, html: true, ...(buttons.length ? { buttons } : {}) }
}

// A tap only queues: the next tick starts the worker, so it can't run anything
// the tick wouldn't, and it can't add permissions.
export async function diagnoseReply(payload: Record<string, string>): Promise<BeaconReply> {
  const i = payload.id ? loadIncident(payload.id) : null
  if (!i) return { text: "That incident is gone; send /incidents again." }
  if (!["recurrence", "blocked", "failed"].includes(i.state)) return { text: `${i.id} is ${i.state} already.` }
  saveIncident({ ...i, state: "queued", attempts: 0, why: undefined })
  return { text: `▶️ Queued ${i.events[0]!.domain}. The next tick starts it, within 5 minutes.` }
}

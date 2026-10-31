// The daily digest: the place a slow-moving problem gets said out loud. It always
// sends, and it's silent unless something is new, because a header that's amber
// every day stops being read. A flag is under New on the day it trips, then under
// Ongoing with its age (docs/2026-10-30_sentinel-spec.md, "The digest").

import type { AppConfig } from "../config.ts"
import type { SpinupWPClientLike } from "../api/client.ts"
import { schedulerModule } from "../modules/scheduler.ts"
import { boardLogin } from "./beaconBoard.ts"
import { listenerHealth } from "./beaconListenInstall.ts"
import { agentCommand, AUTH_FAIL_RE, jobEnv, runProcess } from "./schedulerRun.ts"
import { APT_COMMAND, appendTrends, loadExpectations, readApt, runExpectation, validateExpectation, type ExpectDeps, type ExpectResult } from "./sentinelExpect.ts"
import { isWaiting, loadFleet, loadIncidents, loadPause, readTickLog, saveFleet, saveFlags, readJson, writeJson, sentinelDir, type Fleet, type Flags, type Incident, type SentinelSettings, type TickLine } from "./sentinelState.ts"
import { refreshFleetFrom } from "./sentinelTick.ts"
import { execSshCommand } from "./sshExec.ts"
import { hasIncidentMonitors } from "./cliIncidents.ts"
import { withKuma } from "./uptimeKuma.ts"
import { join } from "node:path"

const CHECK_TIMEOUT_MS = 30_000
const CONCURRENCY = 4
const AGENT_PROBE_MS = 60_000
const DAY_MS = 24 * 3_600_000
const STUCK_MS = DAY_MS

export interface HealthCheck {
  name: string
  ok: boolean
  detail: string
}

export interface DigestData {
  when: Date
  health: HealthCheck[]
  ticks: TickLine[]
  incidents: Incident[]
  results: ExpectResult[]
  aptTotal: number
  apt: ExpectResult[]
  notes: string[]
  paused?: string
}

export interface Digest {
  text: string
  silent: boolean
  flags: Flags
}

const localDay = (d: Date) => d.toLocaleDateString("en-CA")
const dayCount = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)
const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`

export function composeDigest(d: DigestData, flags: Flags): Digest {
  const today = localDay(d.when)
  const since = d.when.getTime() - DAY_MS
  const checks = [...d.results, ...d.apt]
  const next: Flags = {}
  const fresh: string[] = []
  const ongoing: string[] = []
  let acked = 0
  for (const r of checks) {
    if (r.state !== "flag") continue
    const line = `${r.label}: ${r.text}`
    const prior = flags[r.id]
    next[r.id] = { firstSeen: prior?.firstSeen ?? today, text: line, ...(prior?.acked ? { acked: true } : {}) }
    if (!prior || prior.firstSeen === today) fresh.push(line)
    else if (prior.acked) acked++
    else ongoing.push(`${line} (${plural(dayCount(prior.firstSeen, today), "day")})`)
  }
  // A check that couldn't run says nothing either way, so its flag keeps its age.
  for (const r of checks) if (r.state === "unverified" && flags[r.id]) next[r.id] = flags[r.id]!

  const recent = d.incidents.filter((i) => Date.parse(i.createdAt) >= since)
  const stuck = d.incidents.filter((i) => isWaiting(i) && d.when.getTime() - Date.parse(i.createdAt) > STUCK_MS)
  const failing = d.health.filter((h) => !h.ok)
  const reports = recent.filter((i) => i.state === "reported").length
  const recurrences = recent.filter((i) => i.state === "recurrence")
  const blind = d.ticks.filter((t) => !t.ok).length
  const retried = d.ticks.filter((t) => t.ok && t.retries > 0).length

  const date = d.when.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
  const attention = fresh.length > 0 || failing.length > 0 || stuck.length > 0
  const header = !attention ? `✅ Fleet OK — ${date}` : fresh.length ? `⚠️ ${fresh.length} new — ${date}` : `⚠️ Needs attention — ${date}`

  const lines = [header, ""]
  if (d.paused) lines.push(`Paused until ${d.paused}.`, "")
  lines.push(d.health.map((h) => `${h.name}: ${h.ok ? h.detail : `⚠️ ${h.detail}`}`).join("\n"))
  lines.push(`Last 24h: ${plural(d.ticks.length, "check")} · ${plural(recent.length - recurrences.length, "incident")} · ${plural(reports, "report")} · ${plural(recurrences.length, "recurrence")} · ${blind} blind${retried ? ` · ${retried} cold start${retried === 1 ? "" : "s"}` : ""}`)
  if (recurrences.length) {
    const bySite = new Map<string, number>()
    for (const i of recurrences) bySite.set(i.events[0]!.domain, (bySite.get(i.events[0]!.domain) ?? 0) + 1)
    lines.push(`Recurring: ${[...bySite].map(([s, n]) => `${s} ×${n}`).join(", ")}`)
  }
  if (stuck.length) lines.push("", "Stuck:", ...stuck.map((i) => `  ${i.id}: ${i.state}${i.why ? ` (${i.why})` : ""}`))
  if (fresh.length) lines.push("", "New:", ...fresh.map((l) => `  ${l}`))
  if (ongoing.length) lines.push("", "Ongoing:", ...ongoing.map((l) => `  ${l}`))
  if (acked) lines.push("", `${plural(acked, "acknowledged flag")} still set.`)
  const quiet = d.results.filter((r) => r.state !== "flag")
  if (quiet.length) lines.push("", "Checks:", ...quiet.map((r) => `  ${r.label}: ${r.state === "unverified" ? `unverified (${r.text})` : r.text}`))
  if (d.aptTotal) {
    const unverified = d.apt.filter((r) => r.state === "unverified")
    const normal = d.apt.filter((r) => r.state === "ok").length
    lines.push("", `Server updates: ${normal} of ${d.aptTotal} normal${unverified.length ? `, unverified: ${unverified.map((r) => r.label).join(", ")}` : ""}`)
  }
  if (d.notes.length) lines.push("", ...d.notes)
  return { text: lines.join("\n"), silent: !attention, flags: next }
}

// ---- gathering --------------------------------------------------------------------------------

async function bounded<T>(fn: () => Promise<T>, fallback: T, ms = CHECK_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([fn(), new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))])
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i]!)
      }
    }),
  )
  return out
}

// One digest asks about the same fleet dozens of times, and each ssh-exec resolves
// its site through the API. Uncached, the rate limit makes a probe wait out its
// time limit before it has even connected, and it reads as unverified.
export function cachedClient(client: SpinupWPClientLike): SpinupWPClientLike {
  const servers = new Map<string, unknown>()
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if ((prop !== "listServers" && prop !== "listSites") || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value
      return (...args: unknown[]) => {
        const key = `${prop}:${String(args[0])}`
        if (!servers.has(key)) servers.set(key, value.apply(target, args))
        return servers.get(key)
      }
    },
  })
}

export function expectDeps(cfg: AppConfig, client: SpinupWPClientLike): ExpectDeps {
  return {
    exec: async (domain, command, server) => {
      const r = await execSshCommand(domain, command, client, cfg, { server: server ?? null })
      return r.ok ? r.stdout : null
    },
    status: async (url) => {
      try {
        return (await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) })).status
      } catch {
        return null
      }
    },
  }
}

// One attempt per server per day, on the site that worked last: a server with no
// reachable site reads "unverified", and fail2ban never hears about it.
const aptSitesPath = () => join(sentinelDir(), "apt-sites.json")

export function aptTargets(fleet: Fleet, lastGood: Record<string, string>, monitored: Set<string>): { server: string; domain: string }[] {
  const byServer = new Map<string, string[]>()
  for (const [domain, e] of Object.entries(fleet.domains)) {
    if (domain !== e.site) continue
    byServer.set(e.server, [...(byServer.get(e.server) ?? []), domain])
  }
  return [...byServer].sort().map(([server, domains]) => {
    const rank = (d: string) => (d === lastGood[server] ? 0 : monitored.has(d) ? 1 : fleet.domains[d]?.vanity ? 2 : 3)
    return { server, domain: [...domains].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]! }
  })
}

async function checkApt(fleet: Fleet, cfg: AppConfig, deps: ExpectDeps, dryRun: boolean): Promise<ExpectResult[]> {
  const lastGood = readJson<Record<string, string>>(aptSitesPath(), {})
  const monitored = new Set(Object.entries(cfg.kumaMonitors).filter(([, r]) => hasIncidentMonitors(r)).map(([d]) => d))
  const results = await mapLimit(aptTargets(fleet, lastGood, monitored), CONCURRENCY, async ({ server, domain }) => {
    // The server, because a domain can exist on two of them during a move.
    const out = await bounded(() => deps.exec(domain, APT_COMMAND, server), null)
    const read = readApt(out)
    if (read) lastGood[server] = domain
    const base = { id: `apt-${server}`, label: server }
    if (!read) return { ...base, state: "unverified" as const, text: "probe failed" }
    return read.flag ? { ...base, state: "flag" as const, text: read.flag } : { ...base, state: "ok" as const, text: "updating" }
  })
  if (!dryRun) writeJson(aptSitesPath(), lastGood)
  return results
}

async function probeAgent(s: SentinelSettings): Promise<HealthCheck> {
  const env = jobEnv()
  const cmd = agentCommand({ agent: s.agent!, prompt: "Reply with exactly: AUTH_OK", workdir: s.workspace }, env)
  if (typeof cmd === "string") return { name: "Agent", ok: false, detail: cmd }
  const r = await runProcess(cmd, { cwd: sentinelDir(), env, timeoutMs: AGENT_PROBE_MS }).catch((e: Error) => ({ code: 1, output: e.message, timedOut: false }))
  if (r.output.includes("AUTH_OK")) return { name: "Agent", ok: true, detail: "OK" }
  return { name: "Agent", ok: false, detail: AUTH_FAIL_RE.test(r.output) ? `the ${s.agent} login has lapsed` : `unverified (probe ${r.timedOut ? "timed out" : `exited ${r.code}`})` }
}

export async function gatherDigest(s: SentinelSettings, cfg: AppConfig, apiClient: SpinupWPClientLike, opts: { dryRun?: boolean; now?: Date } = {}): Promise<DigestData> {
  const client = cachedClient(apiClient)
  const when = opts.now ?? new Date()
  const notes: string[] = []
  let fleet = loadFleet()
  try {
    fleet = await refreshFleetFrom(client, when)
    if (!opts.dryRun) saveFleet(fleet)
  } catch (err) {
    notes.push(`Couldn't refresh the fleet list: ${(err as Error).message}`)
  }

  const health: HealthCheck[] = []
  const sched = await schedulerModule.status()
  const bad = sched.checks.find((c) => !c.ok && (c.name === "last tick" || c.name === "dispatcher" || c.name === "heartbeat"))
  health.push({ name: "Station", ok: !bad, detail: bad ? `${bad.name}: ${bad.detail}` : "ticking" })
  if (s.agent) health.push(await probeAgent(s))
  if (s.reportTo) {
    const b = await bounded(() => boardLogin(), { ok: false, state: "no" as const, detail: "timed out" })
    health.push({ name: "Board", ok: b.ok, detail: b.ok ? "OK" : b.detail })
  }
  const listener = listenerHealth()
  if (listener) health.push({ name: "Listener", ok: listener.ok, detail: listener.ok ? "OK" : listener.detail })
  if (cfg.uptimeKuma) {
    const ids = await bounded(async () => new Set((await withKuma(cfg.uptimeKuma!, (k) => k.getMonitors())).result.map((m) => m.id)), null)
    if (!ids) health.push({ name: "Kuma", ok: false, detail: "couldn't list monitors" })
    else {
      const gone = Object.entries(cfg.kumaMonitors)
        .filter(([, r]) => Object.entries(r).some(([k, v]) => k.endsWith("Id") && typeof v === "number" && !ids.has(v)))
        .map(([d]) => d)
      health.push({ name: "Kuma", ok: gone.length === 0, detail: gone.length ? `monitors deleted for ${gone.join(", ")}` : "OK" })
    }
  }

  const deps = expectDeps(cfg, client)
  const today = when.getTime()
  const active = loadExpectations().filter((e) => {
    if (validateExpectation(e).length) {
      notes.push(`Skipped invalid check ${e.id}: ${validateExpectation(e).join("; ")}`)
      return false
    }
    if (e.expires && Date.parse(`${e.expires}T23:59:59`) < today) {
      notes.push(`Check ${e.id} expired on ${e.expires} and no longer runs.`)
      return false
    }
    return true
  })
  const results = await mapLimit(active, CONCURRENCY, (e) =>
    bounded(() => runExpectation(e, deps), { id: e.id, label: e.label ?? e.id, state: "unverified" as const, text: "timed out" }, 90_000),
  )
  const apt = await checkApt(fleet, cfg, deps, !!opts.dryRun)
  const pause = loadPause()
  return {
    when,
    health,
    ticks: readTickLog(when.getTime() - DAY_MS),
    incidents: loadIncidents().filter((i) => !i.closedAt || Date.parse(i.createdAt) > when.getTime() - DAY_MS || isWaiting(i)),
    results,
    aptTotal: apt.length,
    apt,
    notes,
    ...(pause && Date.parse(pause.until) > when.getTime() ? { paused: new Date(pause.until).toLocaleString() } : {}),
  }
}

export function recordDigest(digest: Digest, data: DigestData): void {
  saveFlags(digest.flags)
  appendTrends(data.results, localDay(new Date(data.when.getTime() - DAY_MS)))
}


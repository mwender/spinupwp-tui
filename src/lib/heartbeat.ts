// The station heartbeat: the end of every dispatcher tick pings an Uptime Kuma
// push monitor that runs somewhere else.
//
// It covers what nothing on the station can report about itself. If the machine
// is off, the global spinuptui is broken, or the LaunchAgent is gone, the pings
// stop and Kuma pages through its own notifications. And when the pager itself
// is broken (Beacon's last page failed, or Beacon isn't set up) the ping says
// "down", so that failure reaches you without going through Beacon.
//
// The heartbeat belongs to the station, not to a module; it lives in Scheduler,
// the station's clock, until station setup exists. See
// docs/2026-10-20_scheduler-spec.md, "Station heartbeat".

import { loadConfig, saveConfig, type AppConfig, type UptimeKumaConn } from "../config.ts"
import { beaconFromConfig, lastSendLogEntry } from "./beacon.ts"
import { genPushToken, pushUrl, withKuma, type KumaNotificationInfo } from "./uptimeKuma.ts"

export const HEARTBEAT_TIMEOUT_MS = 10_000

export interface HeartbeatResult {
  ok: boolean // Kuma accepted the ping
  status: "up" | "down"
  msg: string
  error?: string
}

// A Kuma push URL: http(s)://host/api/push/<token>, with or without the query
// string Kuma shows (status, msg and ping are set on each ping).
export function parsePushUrl(input: string): URL | null {
  try {
    const u = new URL(input.trim())
    if (u.protocol !== "https:" && u.protocol !== "http:") return null
    if (!/\/api\/push\/[^/]+\/?$/.test(u.pathname)) return null
    u.search = ""
    u.hash = ""
    return u
  } catch {
    return null
  }
}

export function pingUrl(base: string, status: "up" | "down", msg: string, pingMs?: number): string {
  const u = parsePushUrl(base)
  if (!u) throw new Error("not a Kuma push URL")
  u.searchParams.set("status", status)
  u.searchParams.set("msg", msg.slice(0, 250))
  u.searchParams.set("ping", pingMs === undefined ? "" : String(Math.round(pingMs)))
  return u.toString()
}

// Can this station page anyone? Not if Beacon has no channel, or its last
// page failed (that clears itself with the next page that gets through).
export function pagerProblem(cfg: AppConfig = loadConfig(), last = lastSendLogEntry()): string | null {
  if (beaconFromConfig(cfg).channels.length === 0) return "Beacon isn't set up, so nothing can page you"
  if (last && !last.ok) return `Beacon's last page failed (${(last.error ?? "unknown error").slice(0, 120)})`
  return null
}

export async function sendHeartbeat(
  base: string,
  status: "up" | "down",
  msg: string,
  pingMs?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<HeartbeatResult> {
  try {
    const res = await fetchImpl(pingUrl(base, status, msg, pingMs), { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; msg?: string } | null
    if (res.ok && body?.ok) return { ok: true, status, msg }
    return { ok: false, status, msg, error: body?.msg || `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, status, msg, error: e instanceof Error ? e.message : String(e) }
  }
}

// What one tick tells Kuma.
export function tickHeartbeat(ranCount: number, errors: string[], pager: string | null): { status: "up" | "down"; msg: string } {
  if (pager) return { status: "down", msg: `Station is up, but ${pager}` }
  const what = ranCount ? `${ranCount} job${ranCount === 1 ? "" : "s"} ran` : "nothing due"
  return { status: "up", msg: errors.length ? `tick ok, ${what}; ${errors.length} problem${errors.length === 1 ? "" : "s"}: ${errors[0]}` : `tick ok, ${what}` }
}

// ---- setup through SpinupTUI's own Kuma login --------------------------------------
//
// With a Kuma login saved (the one site monitoring uses), SpinupTUI creates the
// station's push monitor itself: one per station, found again by name, so
// re-running repairs rather than duplicates. Without one, `heartbeat set <url>`
// takes a monitor made by hand.

// Three missed 5-minute ticks, the same threshold `scheduler status` uses.
export const STATION_INTERVAL_S = 900

export const stationMonitorName = (host: string) => `SpinupTUI station: ${host}`

export function stationMonitorPayload(name: string, pushToken: string): Record<string, unknown> {
  return {
    type: "push",
    name,
    pushToken,
    description: "Pinged by SpinupTUI's Scheduler at the end of every tick. Down = the station stopped, or it can't page you (see the message).",
    interval: STATION_INTERVAL_S,
    retryInterval: 60,
    maxretries: 0,
    upsideDown: false,
    accepted_statuscodes: ["200-299"],
  }
}

export interface StationMonitorPlan {
  kumaUrl: string
  name: string
  existing: { id: number; url: string } | null
  // Every active notification in this Kuma, and the ones the monitor will use.
  available: KumaNotificationInfo[]
  chosen: KumaNotificationInfo[]
  // Why none could be chosen (ask for --notify), when that's the case.
  needChoice: string | null
}

// Who the station monitor alerts: the one asked for by name or id; else
// Kuma's default notifications; else the only one there is. Several and no
// default means asking: alerting the wrong channel (or none) defeats the point.
export function chooseNotifications(available: KumaNotificationInfo[], want?: string): { chosen: KumaNotificationInfo[]; needChoice: string | null } {
  const list = available.map((n) => `"${n.name}"`).join(", ")
  if (want) {
    const hit = available.find((n) => n.name.toLowerCase() === want.toLowerCase() || String(n.id) === want)
    return hit ? { chosen: [hit], needChoice: null } : { chosen: [], needChoice: `No active Kuma notification called "${want}". Choose one of: ${list}` }
  }
  const defaults = available.filter((n) => n.isDefault)
  if (defaults.length) return { chosen: defaults, needChoice: null }
  if (available.length === 1) return { chosen: available, needChoice: null }
  if (!available.length) return { chosen: [], needChoice: "This Kuma has no active notifications, so the monitor would alert no one. Add one in Kuma (Settings → Notifications) first." }
  return { chosen: [], needChoice: `This Kuma has several notifications and no default. Choose who the station alerts with --notify <name>: ${list}` }
}

export async function planStationMonitor(conn: UptimeKumaConn, host: string, want?: string): Promise<{ plan: StationMonitorPlan; jwt: string }> {
  const name = stationMonitorName(host)
  const { result, jwt } = await withKuma(conn, async (kuma) => {
    const found = (await kuma.getMonitors()).find((m) => m.name === name && m.type === "push" && m.pushToken)
    const available = (await kuma.getNotifications()).filter((n) => n.active)
    return { found, available }
  })
  return {
    plan: {
      kumaUrl: conn.url,
      name,
      existing: result.found ? { id: result.found.id, url: pushUrl(conn.url, result.found.pushToken!) } : null,
      available: result.available,
      ...chooseNotifications(result.available, want),
    },
    jwt,
  }
}

export async function createStationMonitor(conn: UptimeKumaConn, host: string, notificationIds: number[]): Promise<{ id: number; url: string; jwt: string }> {
  const token = genPushToken()
  const notificationIDList = Object.fromEntries(notificationIds.map((id) => [String(id), true]))
  const { result, jwt } = await withKuma(conn, (kuma) => kuma.addMonitor({ ...stationMonitorPayload(stationMonitorName(host), token), notificationIDList }))
  return { id: result, url: pushUrl(conn.url, token), jwt }
}

// ---- the shared flow (CLI `heartbeat setup`/`set`, and the Modules tab) -------------

export type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string; remedy?: string }

// Pings `url` with this station's real state and, if Kuma takes it, saves it.
export async function connectHeartbeat(url: string, host: string, label = "heartbeat connected"): Promise<Outcome<{ status: "up" | "down" }>> {
  if (!parsePushUrl(url)) {
    return { ok: false, message: "That isn't an Uptime Kuma push URL (it looks like https://<kuma>/api/push/<token>…).", remedy: "In Kuma: Add New Monitor → Monitor Type: Push, then copy its Push URL." }
  }
  const cfg = loadConfig()
  const t = tickHeartbeat(0, [], pagerProblem(cfg))
  const r = await sendHeartbeat(url, t.status, `${host}: ${label} (${t.msg})`)
  if (!r.ok) return { ok: false, message: `Kuma didn't take the ping: ${r.error}`, remedy: "Check the URL, that the monitor is active, and that this machine can reach Kuma." }
  await saveConfig({ scheduler: { ...(cfg.scheduler ?? {}), heartbeat: { url: parsePushUrl(url)!.toString(), setAt: new Date().toISOString() } } })
  return { ok: true, status: t.status }
}

export async function removeHeartbeat(): Promise<void> {
  const { heartbeat: _gone, ...rest } = loadConfig().scheduler ?? {}
  await saveConfig({ scheduler: rest })
}

async function saveKumaJwt(conn: UptimeKumaConn, jwt: string): Promise<void> {
  if (!conn.env && jwt && jwt !== conn.jwt) await saveConfig({ uptimeKuma: { url: conn.url, username: conn.username, password: conn.password, jwt } })
}

const NO_KUMA = {
  message: "SpinupTUI has no Uptime Kuma login to set it up with.",
  remedy: "Connect Kuma in the app (site monitoring, M), or make a Push monitor by hand (interval 900s) and give SpinupTUI its push URL.",
}

export async function loadStationPlan(host: string, want?: string): Promise<Outcome<{ plan: StationMonitorPlan }>> {
  const conn = loadConfig().uptimeKuma
  if (!conn) return { ok: false, ...NO_KUMA }
  try {
    const r = await planStationMonitor(conn, host, want)
    await saveKumaJwt(conn, r.jwt)
    return { ok: true, plan: r.plan }
  } catch (e) {
    const msg = (e as Error).message
    return {
      ok: false,
      message: `Couldn't read Uptime Kuma at ${conn.url}: ${msg}`,
      ...(/2FA|token/i.test(msg) ? { remedy: "Its saved session has expired. Log in again from the app (M on any site, with your 2FA code), then try again; it reuses that session." } : {}),
    }
  }
}

export function stationPlanText(plan: StationMonitorPlan): { steps: string[]; notes: string[] } {
  const who = plan.chosen.map((n) => n.name)
  return {
    steps: [
      plan.existing ? `Use the existing Kuma monitor "${plan.name}" (#${plan.existing.id})` : `Create a push monitor "${plan.name}" in ${plan.kumaUrl}: down after ${STATION_INTERVAL_S / 60} min without a ping`,
      "Ping it once, then save it: every dispatcher tick pings it from then on",
    ],
    notes: [
      plan.existing ? "The existing monitor keeps its own notification settings." : `When it goes down, Kuma alerts: ${who.join(", ")}. That doesn't go through Beacon, which is the point.`,
      "Kuma must run on another machine: a monitor on this station would stop with it.",
    ],
  }
}

// Creates the monitor if the plan needs one, then connects. Re-running after a
// failed ping finds the monitor by name and reuses it.
export async function applyStationPlan(plan: StationMonitorPlan, host: string): Promise<Outcome<{ created: number | null; monitorId: number; status: "up" | "down" }>> {
  const conn = loadConfig().uptimeKuma
  if (!conn) return { ok: false, ...NO_KUMA }
  let url = plan.existing?.url
  let created: number | null = null
  if (!url) {
    if (plan.needChoice) return { ok: false, message: plan.needChoice }
    try {
      const r = await createStationMonitor(conn, host, plan.chosen.map((n) => n.id))
      url = r.url
      created = r.id
      await saveKumaJwt(conn, r.jwt)
    } catch (e) {
      return { ok: false, message: `Kuma didn't create the monitor: ${(e as Error).message}` }
    }
  }
  const r = await connectHeartbeat(url, host)
  if (!r.ok) return { ok: false, message: `${created ? `Created monitor #${created}, but ` : ""}${r.message}`, remedy: "Check this machine can reach Kuma, then try again: it reuses the monitor." }
  return { ok: true, created, monitorId: created ?? plan.existing!.id, status: r.status }
}

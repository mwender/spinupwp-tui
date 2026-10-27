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

import { loadConfig, type AppConfig, type UptimeKumaConn } from "../config.ts"
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

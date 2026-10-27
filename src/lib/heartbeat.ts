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

import { loadConfig, type AppConfig } from "../config.ts"
import { beaconFromConfig, lastSendLogEntry } from "./beacon.ts"

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

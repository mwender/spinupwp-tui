// Take a server's sites offline, and bring back exactly those sites later.
//
// For emergencies like an unpatched PHP remote-code-execution bug: SpinupWP's
// "disable site" removes the site's nginx server block, so port 80 returns an
// empty reply, 443 fails the TLS handshake, and no request reaches PHP (checked
// on a test box with direct-IP and --resolve requests too). Files, database,
// certificate, the PHP-FPM pool and the site's cron are all left in place.
//
// PHP is shared by every site on a server, so the usual unit is the server:
// one still-enabled site keeps the vulnerable binary reachable. Single sites
// can go offline too (one exposed site, or one client's site for reasons of its
// own); they're recorded under their server the same way. What this module
// disabled is recorded per server in `offline.json` (per account), and bringing
// a server back only re-enables those sites. A site someone had disabled for
// another reason stays disabled.
//
// Kuma: every monitor registered for the affected sites goes behind one manual
// maintenance window per server, so taking 30 sites down doesn't page 30 times.
// Best-effort both ways; Kuma being unreachable never blocks the API work.

import { existsSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { AppConfig, KumaMonitorRef } from "../config.ts"
import { profileDataDir } from "../config.ts"
import type { Event, Server, Site } from "../api/types.ts"
import type { SpinupWPClientLike } from "../api/client.ts"
import { ApiError } from "../api/client.ts"
import { withKuma } from "./uptimeKuma.ts"

// ---- State ----------------------------------------------------------------

export interface OfflineSite {
  id: number
  domain: string
}

export interface OfflineRecord {
  serverId: number
  serverName: string
  takenAt: string
  // Only the sites this module disabled; the only ones "online" re-enables.
  sites: OfflineSite[]
  kumaMaintenanceId?: number
}

export interface OfflineState {
  servers: Record<string, OfflineRecord>
}

export function offlineStatePath(dir = profileDataDir()): string {
  return join(dir, "offline.json")
}

export function loadOfflineState(dir = profileDataDir()): OfflineState {
  try {
    const path = offlineStatePath(dir)
    if (!existsSync(path)) return { servers: {} }
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<OfflineState>
    return { servers: raw.servers ?? {} }
  } catch {
    return { servers: {} }
  }
}

// Read-modify-write, so a CLI run and the app working on different servers
// don't overwrite each other's records.
async function updateRecord(dir: string, serverId: number, fn: (r: OfflineRecord | undefined) => OfflineRecord | undefined): Promise<void> {
  const state = loadOfflineState(dir)
  const next = fn(state.servers[String(serverId)])
  if (next) state.servers[String(serverId)] = next
  else delete state.servers[String(serverId)]
  await mkdir(dir, { recursive: true })
  await Bun.write(offlineStatePath(dir), JSON.stringify(state, null, 2) + "\n")
}

// ---- Event waiting ----------------------------------------------------------

const EVENT_DONE = new Set(["deployed", "completed", "finished", "success"])
const EVENT_FAIL = new Set(["failed", "errored", "error"])

export type EventOutcome = "done" | "failed" | "timeout"

// Wait on many events at once. One `GET /events` page covers the 100 newest,
// so a whole server (or fleet) costs one request per round instead of one per
// site; anything that has scrolled off that page is fetched individually. A
// timeout is reported as a timeout, never a failure: SpinupWP runs a server's
// events one at a time, so a big server's last site can sit queued a while.
export async function waitForEvents(
  client: SpinupWPClientLike,
  ids: number[],
  opts: { timeoutMs?: number; pollMs?: number; onSettled?: (id: number, outcome: EventOutcome, event?: Event) => void } = {},
): Promise<Map<number, EventOutcome>> {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000
  const pollMs = opts.pollMs ?? 4000
  const out = new Map<number, EventOutcome>()
  const pending = new Set(ids)
  const settle = (id: number, outcome: EventOutcome, ev?: Event) => {
    pending.delete(id)
    out.set(id, outcome)
    opts.onSettled?.(id, outcome, ev)
  }
  const judge = (ev: Event) => {
    if (!pending.has(ev.id)) return
    if (EVENT_FAIL.has(ev.status)) settle(ev.id, "failed", ev)
    else if (EVENT_DONE.has(ev.status) || ev.finished_at) settle(ev.id, "done", ev)
  }
  const deadline = Date.now() + timeoutMs
  let apiErrs = 0
  while (pending.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    try {
      const recent = await client.listEvents(1)
      apiErrs = 0
      const seen = new Set<number>()
      for (const ev of recent) {
        seen.add(ev.id)
        judge(ev)
      }
      const oldest = recent.length ? Math.min(...recent.map((e) => e.id)) : Infinity
      for (const id of [...pending]) {
        if (seen.has(id) || id >= oldest) continue
        judge(await client.getEvent(id))
      }
    } catch {
      // A failed read isn't a failed event; give up only on a run of them.
      if (++apiErrs >= 5) break
    }
  }
  for (const id of pending) settle(id, "timeout")
  return out
}

// ---- Kuma -----------------------------------------------------------------

// Every monitor registered for a site: any numeric `*Id` on its ref, by the
// same convention the alerts toggle uses, so new monitor kinds are covered.
function monitorIdsFor(ref: KumaMonitorRef | undefined): number[] {
  if (!ref) return []
  return Object.entries(ref)
    .filter((e): e is [string, number] => e[0].endsWith("Id") && typeof e[1] === "number")
    .map(([, id]) => id)
}

export type KumaOutcome = "shielded" | "no_monitors" | "not_configured" | "failed" | "skipped"

async function shieldMonitors(cfg: AppConfig, server: Server, domains: string[], existingId?: number): Promise<{ outcome: KumaOutcome; id?: number; error?: string }> {
  const conn = cfg.uptimeKuma
  if (!conn) return { outcome: "not_configured" }
  const ids = [...new Set(domains.flatMap((d) => monitorIdsFor(cfg.kumaMonitors[d])))]
  if (!ids.length) return { outcome: "no_monitors" }
  try {
    const { result } = await withKuma(conn, async (kuma) => {
      // A re-run after a partial one widens the window it already opened.
      if (existingId != null) {
        try {
          await kuma.setMaintenanceMonitors(existingId, ids)
          return existingId
        } catch {
          // Deleted in Kuma meanwhile; open a fresh one.
        }
      }
      const id = await kuma.addManualMaintenance(`Offline: ${server.name}`, "Sites taken offline from SpinupTUI. Removed automatically when they come back online.")
      try {
        await kuma.setMaintenanceMonitors(id, ids)
      } catch (err) {
        await kuma.deleteMaintenance(id).catch(() => {})
        throw err
      }
      return id
    })
    return { outcome: "shielded", id: result }
  } catch (err) {
    return { outcome: "failed", error: (err as Error).message }
  }
}

// ---- Server lookup --------------------------------------------------------

export type ServerMatch = { ok: true; server: Server } | { ok: false; query: string; message: string; suggestions: string[] }

// Exact matches only (name, IP or id). A write that takes sites down must
// never act on a near-miss; a miss lists names that contain the query.
export function matchServer(servers: Server[], query: string): ServerMatch {
  const q = query.trim().toLowerCase()
  const hit = servers.find((s) => s.name.toLowerCase() === q || s.ip_address === q || String(s.id) === q)
  if (hit) return { ok: true, server: hit }
  const suggestions = servers.filter((s) => s.name.toLowerCase().includes(q)).map((s) => s.name).slice(0, 8)
  return { ok: false, query, message: `No server named "${query}".`, suggestions }
}

// ---- Take offline ---------------------------------------------------------

export interface OfflineServerResult {
  serverId: number
  serverName: string
  // Disabled by this run.
  disabled: string[]
  // Already disabled before this run; left alone and not recorded.
  alreadyOffline: string[]
  failed: { domain: string; error: string }[]
  kuma: KumaOutcome
  kumaError?: string
}

export interface OfflineOptions {
  dir?: string
  onProgress?: (line: string) => void
  // False in Dev Mode: never talk to a real Kuma.
  kuma?: boolean
  timeoutMs?: number
  pollMs?: number
}

const errMsg = (err: unknown) => (err instanceof ApiError ? err.message : (err as Error).message)

export async function takeServerOffline(client: SpinupWPClientLike, cfg: AppConfig, server: Server, opts: OfflineOptions = {}): Promise<OfflineServerResult> {
  const sites = await client.listSites(server.id)
  const result = emptyOfflineResult(server)
  result.alreadyOffline = sites.filter((s) => s.disabled_at).map((s) => s.domain)
  const targets = sites.filter((s) => !s.disabled_at)
  if (!targets.length) {
    opts.onProgress?.(`${server.name}: every site is already offline`)
    return result
  }
  return disableSites(client, cfg, server, targets, result, opts)
}

// One site. The rest of the server stays up, and so does its PHP: this
// protects that site, not the server.
export async function takeSiteOffline(client: SpinupWPClientLike, cfg: AppConfig, server: Server, siteId: number, opts: OfflineOptions = {}): Promise<OfflineServerResult> {
  const site = (await client.listSites(server.id)).find((s) => s.id === siteId)
  const result = emptyOfflineResult(server)
  if (!site) throw new Error(`Site ${siteId} is no longer on ${server.name}.`)
  if (site.disabled_at) {
    result.alreadyOffline = [site.domain]
    opts.onProgress?.(`${site.domain}: already offline`)
    return result
  }
  return disableSites(client, cfg, server, [site], result, opts)
}

function emptyOfflineResult(server: Server): OfflineServerResult {
  return { serverId: server.id, serverName: server.name, disabled: [], alreadyOffline: [], failed: [], kuma: "skipped" }
}

async function disableSites(
  client: SpinupWPClientLike,
  cfg: AppConfig,
  server: Server,
  targets: Site[],
  result: OfflineServerResult,
  opts: OfflineOptions,
): Promise<OfflineServerResult> {
  const dir = opts.dir ?? profileDataDir(cfg.profileId)
  const say = opts.onProgress ?? (() => {})

  const existing = loadOfflineState(dir).servers[String(server.id)]
  if (opts.kuma !== false) {
    const domains = [...new Set([...(existing?.sites ?? []).map((s) => s.domain), ...targets.map((s) => s.domain)])]
    const k = await shieldMonitors(cfg, server, domains, existing?.kumaMaintenanceId)
    result.kuma = k.outcome
    if (k.error) result.kumaError = k.error
    if (k.id != null) {
      await updateRecord(dir, server.id, (r) => ({
        ...(r ?? { serverId: server.id, serverName: server.name, takenAt: new Date().toISOString(), sites: [] }),
        kumaMaintenanceId: k.id,
      }))
    }
  }

  // Record each site the moment its disable is accepted, before it finishes:
  // if this process dies mid-run, "online" still knows to bring it back, and
  // restoring a site that never went down is a harmless no-op.
  const events = new Map<number, Site>()
  for (const site of targets) {
    try {
      const { event_id } = await client.disableSite(site.id)
      events.set(event_id, site)
      await updateRecord(dir, server.id, (r) => {
        const rec = r ?? { serverId: server.id, serverName: server.name, takenAt: new Date().toISOString(), sites: [] }
        if (!rec.sites.some((s) => s.id === site.id)) rec.sites.push({ id: site.id, domain: site.domain })
        return rec
      })
      say(`${site.domain}: going offline…`)
    } catch (err) {
      result.failed.push({ domain: site.domain, error: errMsg(err) })
      say(`${site.domain}: ✕ ${errMsg(err)}`)
    }
  }

  await waitForEvents(client, [...events.keys()], {
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    onSettled: (id, outcome, ev) => {
      const site = events.get(id)!
      if (outcome === "done") {
        result.disabled.push(site.domain)
        say(`${site.domain}: ✓ offline`)
      } else if (outcome === "failed") {
        const error = ev?.output?.trim() || "SpinupWP reported the disable as failed."
        result.failed.push({ domain: site.domain, error })
        say(`${site.domain}: ✕ ${error}`)
      } else {
        result.failed.push({ domain: site.domain, error: "Still queued at SpinupWP when we stopped waiting; it may yet complete. Re-run to check." })
        say(`${site.domain}: … still queued at SpinupWP`)
      }
    },
  })
  return result
}

// ---- Bring back online ----------------------------------------------------

export interface OnlineServerResult {
  serverId: number
  serverName: string
  enabled: string[]
  // Recorded, but already serving again (enabled by hand, say).
  alreadyOnline: string[]
  // Recorded, but deleted from SpinupWP since.
  gone: string[]
  failed: { domain: string; error: string }[]
  // Nothing recorded for this server: this module didn't take it offline.
  nothingRecorded: boolean
  // Asked for by id but not taken offline by this module (siteIds only).
  notRecorded: number[]
  kumaWindowClosed: boolean
}

// Bring back what this module took offline on a server: all of it, or only
// `siteIds` from it.
export async function bringServerOnline(
  client: SpinupWPClientLike,
  cfg: AppConfig,
  serverId: number,
  opts: OfflineOptions & { siteIds?: number[] } = {},
): Promise<OnlineServerResult> {
  const dir = opts.dir ?? profileDataDir(cfg.profileId)
  const say = opts.onProgress ?? (() => {})
  const record = loadOfflineState(dir).servers[String(serverId)]
  const result: OnlineServerResult = {
    serverId,
    serverName: record?.serverName ?? String(serverId),
    enabled: [],
    alreadyOnline: [],
    gone: [],
    failed: [],
    nothingRecorded: !record,
    notRecorded: opts.siteIds?.filter((id) => !record?.sites.some((s) => s.id === id)) ?? [],
    kumaWindowClosed: false,
  }
  if (!record) return result
  const wanted = opts.siteIds ? record.sites.filter((s) => opts.siteIds!.includes(s.id)) : record.sites

  const live = new Map((await client.listSites(serverId)).map((s) => [s.id, s]))
  const done = new Set<number>()
  const events = new Map<number, OfflineSite>()
  for (const rec of wanted) {
    const site = live.get(rec.id)
    if (!site) {
      result.gone.push(rec.domain)
      done.add(rec.id)
      continue
    }
    if (!site.disabled_at) {
      result.alreadyOnline.push(rec.domain)
      done.add(rec.id)
      continue
    }
    try {
      const { event_id } = await client.enableSite(rec.id)
      events.set(event_id, rec)
      say(`${rec.domain}: coming back online…`)
    } catch (err) {
      result.failed.push({ domain: rec.domain, error: errMsg(err) })
      say(`${rec.domain}: ✕ ${errMsg(err)}`)
    }
  }

  await waitForEvents(client, [...events.keys()], {
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    onSettled: (id, outcome, ev) => {
      const rec = events.get(id)!
      if (outcome === "done") {
        result.enabled.push(rec.domain)
        done.add(rec.id)
        say(`${rec.domain}: ✓ online`)
      } else {
        const error = outcome === "failed" ? ev?.output?.trim() || "SpinupWP reported the enable as failed." : "Still queued at SpinupWP when we stopped waiting. Re-run to check."
        result.failed.push({ domain: rec.domain, error })
        say(`${rec.domain}: ✕ ${error}`)
      }
    },
  })

  // Keep whatever didn't come back, so a re-run finishes the job. The Kuma
  // window shrinks to the sites still offline, and closes once there are none
  // (or none of them has monitors).
  let left: OfflineSite[] = []
  await updateRecord(dir, serverId, (r) => {
    if (!r) return undefined
    left = r.sites.filter((s) => !done.has(s.id))
    return left.length ? { ...r, sites: left } : undefined
  })
  if (done.size && record.kumaMaintenanceId != null && cfg.uptimeKuma && opts.kuma !== false) {
    const id = record.kumaMaintenanceId
    const stillShielded = [...new Set(left.flatMap((s) => monitorIdsFor(cfg.kumaMonitors[s.domain])))]
    if (stillShielded.length) {
      await withKuma(cfg.uptimeKuma, (kuma) => kuma.setMaintenanceMonitors(id, stillShielded)).catch(() => {
        // The restored sites stay quiet in Kuma until the rest come back.
      })
    } else {
      result.kumaWindowClosed = await withKuma(cfg.uptimeKuma, (kuma) => kuma.deleteMaintenance(id))
        .then(() => true)
        .catch(() => false)
      if (left.length) await updateRecord(dir, serverId, (r) => (r ? { ...r, kumaMaintenanceId: undefined } : r))
    }
  }
  return result
}

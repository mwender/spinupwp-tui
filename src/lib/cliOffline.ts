// `spinuptui offline` / `spinuptui online` — take whole servers' sites offline
// and bring them back. See lib/offline.ts for what "offline" means on the box.
//
//   spinuptui offline                          what's offline right now
//   spinuptui offline <server>… | --all --yes  take every site on them offline
//   spinuptui online  <server>… | --all --yes  bring back what `offline` took down
//
// Without --yes both commands print the plan and change nothing. Progress goes
// to stderr; stdout carries the summary (or one JSON object with --json).

import type { AppConfig } from "../config.ts"
import { loadConfig } from "../config.ts"
import type { Server, Site } from "../api/types.ts"
import { SpinupWPClient, ApiError } from "../api/client.ts"
import {
  loadOfflineState,
  matchServer,
  takeServerOffline,
  bringServerOnline,
  type OfflineServerResult,
  type OnlineServerResult,
} from "./offline.ts"

// Servers are worked on side by side (SpinupWP queues events per server, so
// sites on one server finish one after another regardless); capped so a fleet
// run doesn't fire every POST in the first second.
const SERVER_CONCURRENCY = 4

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

interface Parsed {
  names: string[]
  all: boolean
  yes: boolean
  json: boolean
}

function parse(args: string[]): Parsed {
  return {
    names: args.filter((a) => !a.startsWith("-")),
    all: args.includes("--all"),
    yes: args.includes("--yes"),
    json: args.includes("--json"),
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
const err = (line: string) => process.stderr.write(line + "\n")

function fail(json: boolean, reason: string, message: string, extra: Record<string, unknown> = {}): number {
  if (json) console.log(JSON.stringify({ ok: false, reason, message, ...extra }))
  else err(message)
  return 1
}

function apiFailure(json: boolean, e: unknown): number {
  if (e instanceof ApiError && e.status === 401) return fail(json, "token_rejected", "Saved API token was rejected (401). Run `spinuptui login` to save a fresh one.")
  return fail(json, "api_error", e instanceof ApiError ? e.message : `Unexpected error: ${(e as Error).message}`)
}

// Resolve every name, or report all the misses at once.
function resolveServers(servers: Server[], names: string[]): { ok: true; servers: Server[] } | { ok: false; message: string } {
  const picked: Server[] = []
  const misses: string[] = []
  for (const name of names) {
    const m = matchServer(servers, name)
    if (m.ok) {
      if (!picked.includes(m.server)) picked.push(m.server)
    } else {
      misses.push(m.suggestions.length ? `${m.message} Did you mean: ${m.suggestions.join(", ")}?` : m.message)
    }
  }
  return misses.length ? { ok: false, message: misses.join("\n") } : { ok: true, servers: picked }
}

// ---- status ---------------------------------------------------------------

async function status(client: SpinupWPClient, cfg: AppConfig, json: boolean): Promise<number> {
  const state = loadOfflineState()
  let servers: Server[]
  let sites: Site[]
  try {
    ;[servers, sites] = await Promise.all([client.listServers(), client.listSites()])
  } catch (e) {
    return apiFailure(json, e)
  }
  const byServer = new Map<number, Site[]>()
  for (const s of sites) byServer.set(s.server_id, [...(byServer.get(s.server_id) ?? []), s])

  const rows = servers
    .map((srv) => {
      const all = byServer.get(srv.id) ?? []
      const off = all.filter((s) => s.disabled_at)
      const rec = state.servers[String(srv.id)]
      return { server: srv.name, id: srv.id, sites: all.length, offline: off.map((s) => s.domain), takenOfflineBySpinupTUI: rec?.sites.map((s) => s.domain) ?? [], since: rec?.takenAt ?? null }
    })
    .filter((r) => r.offline.length || r.takenOfflineBySpinupTUI.length)

  if (json) {
    console.log(JSON.stringify({ ok: true, account: cfg.profileLabel, servers: rows }))
    return 0
  }
  if (!rows.length) {
    console.log(`Every site on ${plural(servers.length, "server")} is online.`)
    return 0
  }
  for (const r of rows) {
    const whole = r.offline.length === r.sites ? "all sites offline" : `${r.offline.length} of ${plural(r.sites, "site")} offline`
    console.log(`${r.server}: ${whole}${r.since ? ` (taken offline ${r.since})` : ""}`)
    for (const d of r.offline) console.log(`  ${r.takenOfflineBySpinupTUI.includes(d) ? "·" : "○"} ${d}`)
  }
  if (rows.some((r) => r.offline.some((d) => !r.takenOfflineBySpinupTUI.includes(d)))) {
    console.log("\n○ = disabled outside `spinuptui offline`; `spinuptui online` leaves these alone.")
  }
  return 0
}

// ---- offline --------------------------------------------------------------

export async function runOffline(args: string[]): Promise<number> {
  const p = parse(args)
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  if (!p.names.length && !p.all) return status(client, cfg, p.json)
  if (p.names.length && p.all) return fail(p.json, "usage", "Name servers or pass --all, not both.")

  let servers: Server[]
  let sites: Site[]
  try {
    ;[servers, sites] = await Promise.all([client.listServers(), client.listSites()])
  } catch (e) {
    return apiFailure(p.json, e)
  }
  let targets = servers
  if (!p.all) {
    const r = resolveServers(servers, p.names)
    if (!r.ok) return fail(p.json, "server_not_found", r.message)
    targets = r.servers
  }

  if (!p.yes) {
    const plan = targets.map((srv) => {
      const on = sites.filter((s) => s.server_id === srv.id)
      return { server: srv.name, id: srv.id, willDisable: on.filter((s) => !s.disabled_at).map((s) => s.domain), alreadyOffline: on.filter((s) => s.disabled_at).map((s) => s.domain) }
    })
    if (p.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, servers: plan }))
      return 0
    }
    const total = plan.reduce((n, s) => n + s.willDisable.length, 0)
    console.log(`Would take ${plural(total, "site")} offline on ${plural(plan.length, "server")} (${cfg.profileLabel}):`)
    for (const s of plan) {
      console.log(`  ${s.server}: ${plural(s.willDisable.length, "site")}${s.alreadyOffline.length ? ` (+${s.alreadyOffline.length} already offline)` : ""}`)
      for (const d of s.willDisable) console.log(`    · ${d}`)
    }
    console.log("\nOffline means nginx stops answering for these domains: visitors can't connect, and no request reaches PHP.")
    console.log("Files, databases and certificates are untouched. Nothing has changed yet; add --yes to do it.")
    return 0
  }

  const results = await mapLimit(targets, SERVER_CONCURRENCY, async (srv): Promise<OfflineServerResult | { serverName: string; error: string }> => {
    try {
      return await takeServerOffline(client, cfg, srv, { onProgress: (l) => err(`→ ${l}`) })
    } catch (e) {
      return { serverName: srv.name, error: e instanceof ApiError ? e.message : (e as Error).message }
    }
  })

  const failedAny = results.some((r) => "error" in r || r.failed.length)
  if (p.json) {
    console.log(JSON.stringify({ ok: !failedAny, servers: results }))
    return failedAny ? 1 : 0
  }
  console.log("")
  for (const r of results) {
    if ("error" in r) {
      console.log(`✕ ${r.serverName}: ${r.error}`)
      continue
    }
    const bits = [`${plural(r.disabled.length, "site")} taken offline`]
    if (r.alreadyOffline.length) bits.push(`${r.alreadyOffline.length} already offline`)
    if (r.failed.length) bits.push(`${r.failed.length} failed`)
    console.log(`${r.failed.length ? "✕" : "✓"} ${r.serverName}: ${bits.join(", ")}`)
    for (const f of r.failed) console.log(`    ✕ ${f.domain}: ${f.error}`)
    if (r.kuma === "shielded") console.log("    Uptime Kuma: monitors are in a maintenance window until they come back.")
    if (r.kuma === "failed") console.log(`    Uptime Kuma: couldn't open a maintenance window (${r.kumaError}); expect down alerts.`)
  }
  console.log("\nBring them back with: spinuptui online " + (p.all ? "--all" : targets.map((s) => s.name).join(" ")) + " --yes")
  return failedAny ? 1 : 0
}

// ---- online ---------------------------------------------------------------

export async function runOnline(args: string[]): Promise<number> {
  const p = parse(args)
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  if (!p.names.length && !p.all) return fail(p.json, "usage", "Usage: spinuptui online <server>… | --all [--yes]")
  if (p.names.length && p.all) return fail(p.json, "usage", "Name servers or pass --all, not both.")

  const state = loadOfflineState()
  let ids: number[]
  if (p.all) {
    ids = Object.keys(state.servers).map(Number)
  } else {
    let servers: Server[]
    try {
      servers = await client.listServers()
    } catch (e) {
      return apiFailure(p.json, e)
    }
    const r = resolveServers(servers, p.names)
    if (!r.ok) return fail(p.json, "server_not_found", r.message)
    ids = r.servers.map((s) => s.id)
    const unknown = r.servers.filter((s) => !state.servers[String(s.id)])
    if (unknown.length) {
      return fail(
        p.json,
        "nothing_recorded",
        `SpinupTUI didn't take ${unknown.map((s) => s.name).join(", ")} offline, so there's nothing to bring back. Sites disabled elsewhere are re-enabled in SpinupWP itself.`,
      )
    }
  }
  if (!ids.length) {
    if (p.json) console.log(JSON.stringify({ ok: true, servers: [] }))
    else console.log("Nothing is offline from SpinupTUI on this account.")
    return 0
  }

  if (!p.yes) {
    const plan = ids.map((id) => state.servers[String(id)]!)
    if (p.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, servers: plan.map((r) => ({ server: r.serverName, id: r.serverId, willEnable: r.sites.map((s) => s.domain) })) }))
      return 0
    }
    for (const r of plan) {
      console.log(`${r.serverName}: would bring ${plural(r.sites.length, "site")} back online (offline since ${r.takenAt})`)
      for (const s of r.sites) console.log(`    · ${s.domain}`)
    }
    console.log("\nOnly sites `spinuptui offline` took down are re-enabled. Nothing has changed yet; add --yes to do it.")
    return 0
  }

  const results = await mapLimit(ids, SERVER_CONCURRENCY, async (id): Promise<OnlineServerResult | { serverName: string; error: string }> => {
    try {
      return await bringServerOnline(client, cfg, id, { onProgress: (l) => err(`→ ${l}`) })
    } catch (e) {
      return { serverName: state.servers[String(id)]?.serverName ?? String(id), error: e instanceof ApiError ? e.message : (e as Error).message }
    }
  })

  const failedAny = results.some((r) => "error" in r || r.failed.length)
  if (p.json) {
    console.log(JSON.stringify({ ok: !failedAny, servers: results }))
    return failedAny ? 1 : 0
  }
  console.log("")
  for (const r of results) {
    if ("error" in r) {
      console.log(`✕ ${r.serverName}: ${r.error}`)
      continue
    }
    const bits = [`${plural(r.enabled.length, "site")} back online`]
    if (r.alreadyOnline.length) bits.push(`${r.alreadyOnline.length} already online`)
    if (r.gone.length) bits.push(`${r.gone.length} no longer exist`)
    if (r.failed.length) bits.push(`${r.failed.length} failed — re-run to retry`)
    console.log(`${r.failed.length ? "✕" : "✓"} ${r.serverName}: ${bits.join(", ")}`)
    for (const f of r.failed) console.log(`    ✕ ${f.domain}: ${f.error}`)
    if (r.kumaWindowClosed) console.log("    Uptime Kuma: maintenance window closed; monitoring resumed.")
  }
  return failedAny ? 1 : 0
}

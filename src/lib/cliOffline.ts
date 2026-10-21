// `spinuptui offline` / `spinuptui online` — take whole servers' sites offline
// and bring them back. See lib/offline.ts for what "offline" means on the box.
//
//   spinuptui offline                          what's offline right now
//   spinuptui offline <server>… | --all --yes  take every site on them offline
//   spinuptui offline --site <domain> --yes    just that site
//   spinuptui online  <server>… | --all --yes  bring back what `offline` took down
//   spinuptui online  --site <domain> --yes    just that site
//
// Without --yes both commands print the plan and change nothing. Progress goes
// to stderr; stdout carries the summary (or one JSON object with --json).

import type { AppConfig } from "../config.ts"
import { loadConfig } from "../config.ts"
import type { Server, Site } from "../api/types.ts"
import { SpinupWPClient, ApiError } from "../api/client.ts"
import { resolveSiteByDomain } from "./cliSsh.ts"
import {
  loadOfflineState,
  matchServer,
  takeServerOffline,
  bringServerOnline,
  takeSiteOffline,
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
  // --site <domain>, with --server <name> when the domain is on two servers.
  site: string | null
  server: string | null
}

const VALUE_FLAGS = new Set(["--site", "--server"])

function parse(args: string[]): Parsed {
  const names: string[] = []
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (VALUE_FLAGS.has(a)) values.set(a, args[++i] ?? "")
    else if (!a.startsWith("-")) names.push(a)
  }
  return {
    names,
    all: args.includes("--all"),
    yes: args.includes("--yes"),
    json: args.includes("--json"),
    site: values.has("--site") ? values.get("--site")! : null,
    server: values.get("--server") ?? null,
  }
}

// --site combines with nothing else that picks a target.
function siteUsageError(p: Parsed): string | null {
  if (p.site === null) return p.server !== null ? "--server only narrows --site; name servers directly otherwise." : null
  if (!p.site || p.site.startsWith("-")) return "--site needs a domain, e.g. --site example.com"
  if (p.names.length || p.all) return "--site takes one site; don't also name servers or pass --all."
  return null
}

// Find the site behind a domain (primary or additional), and its server.
async function resolveSite(client: SpinupWPClient, cfg: AppConfig, p: Parsed): Promise<{ ok: true; site: Site; server: Server } | { ok: false; code: number }> {
  const r = await resolveSiteByDomain(p.site!, client, cfg, { server: p.server })
  if (r.ok) return { ok: true, site: r.site, server: r.server }
  const lines = [r.result.message, ...(r.result.candidates ?? []).map((c) => `  · ${c.server} (site ${c.siteId})`)]
  if (r.result.reason === "multiple_matches") lines.push("Pick one with --server <name>.")
  else if (r.result.remedy) lines.push(r.result.remedy)
  return { ok: false, code: fail(p.json, r.result.reason, lines.join("\n"), { candidates: r.result.candidates }) }
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
  const siteErr = siteUsageError(p)
  if (siteErr) return fail(p.json, "usage", siteErr)
  if (p.site !== null) return siteOffline(client, cfg, p)
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

async function siteOffline(client: SpinupWPClient, cfg: AppConfig, p: Parsed): Promise<number> {
  const r = await resolveSite(client, cfg, p)
  if (!r.ok) return r.code
  const { site, server } = r
  let neighbours: Site[]
  try {
    neighbours = (await client.listSites(server.id)).filter((s) => s.id !== site.id && !s.disabled_at)
  } catch (e) {
    return apiFailure(p.json, e)
  }
  const exposure = neighbours.length
    ? `${plural(neighbours.length, "other site")} on ${server.name} stay${neighbours.length === 1 ? "s" : ""} up, so that server's PHP is still reachable through ${neighbours.length === 1 ? "it" : "them"}. To protect the server, take it offline: spinuptui offline ${server.name} --yes`
    : `It's the only site still up on ${server.name}, so this takes the whole server's sites offline.`

  if (site.disabled_at) {
    if (p.json) console.log(JSON.stringify({ ok: true, dryRun: !p.yes, server: server.name, alreadyOffline: [site.domain] }))
    else console.log(`${site.domain} is already offline.`)
    return 0
  }
  if (!p.yes) {
    if (p.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, server: server.name, willDisable: [site.domain], otherSitesStillUp: neighbours.map((s) => s.domain) }))
      return 0
    }
    console.log(`Would take ${site.domain} offline (on ${server.name}, ${cfg.profileLabel}).`)
    console.log(exposure)
    console.log("\nOffline means nginx stops answering for its domains: visitors can't connect, and no request reaches PHP through this site.")
    console.log("Files, database and certificate are untouched. Nothing has changed yet; add --yes to do it.")
    return 0
  }

  let res: OfflineServerResult
  try {
    res = await takeSiteOffline(client, cfg, server, site.id, { onProgress: (l) => err(`→ ${l}`) })
  } catch (e) {
    return apiFailure(p.json, e)
  }
  const failed = res.failed.length > 0
  if (p.json) {
    console.log(JSON.stringify({ ok: !failed, servers: [res] }))
    return failed ? 1 : 0
  }
  console.log("")
  if (failed) for (const f of res.failed) console.log(`✕ ${f.domain}: ${f.error}`)
  else console.log(`✓ ${site.domain} is offline.`)
  if (res.kuma === "shielded") console.log("    Uptime Kuma: its monitors are in a maintenance window until it comes back.")
  if (res.kuma === "failed") console.log(`    Uptime Kuma: couldn't open a maintenance window (${res.kumaError}); expect down alerts.`)
  if (!failed) {
    if (neighbours.length) console.log(exposure)
    console.log(`\nBring it back with: spinuptui online --site ${site.domain} --yes`)
  }
  return failed ? 1 : 0
}

// ---- online ---------------------------------------------------------------

export async function runOnline(args: string[]): Promise<number> {
  const p = parse(args)
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  const siteErr = siteUsageError(p)
  if (siteErr) return fail(p.json, "usage", siteErr)
  if (p.site !== null) return siteOnline(client, cfg, p)
  if (!p.names.length && !p.all) return fail(p.json, "usage", "Usage: spinuptui online <server>… | --all | --site <domain> [--yes]")
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

async function siteOnline(client: SpinupWPClient, cfg: AppConfig, p: Parsed): Promise<number> {
  const r = await resolveSite(client, cfg, p)
  if (!r.ok) return r.code
  const { site, server } = r
  const record = loadOfflineState().servers[String(server.id)]
  if (!record?.sites.some((s) => s.id === site.id)) {
    return fail(
      p.json,
      "nothing_recorded",
      site.disabled_at
        ? `${site.domain} is offline, but not because of SpinupTUI, so it's left alone. Re-enable it in SpinupWP itself.`
        : `${site.domain} is already online.`,
    )
  }
  if (!p.yes) {
    if (p.json) console.log(JSON.stringify({ ok: true, dryRun: true, server: server.name, willEnable: [site.domain] }))
    else console.log(`Would bring ${site.domain} back online (on ${server.name}, offline since ${record.takenAt}). Nothing has changed yet; add --yes to do it.`)
    return 0
  }
  let res: OnlineServerResult
  try {
    res = await bringServerOnline(client, cfg, server.id, { siteIds: [site.id], onProgress: (l) => err(`→ ${l}`) })
  } catch (e) {
    return apiFailure(p.json, e)
  }
  const failed = res.failed.length > 0
  if (p.json) {
    console.log(JSON.stringify({ ok: !failed, servers: [res] }))
    return failed ? 1 : 0
  }
  console.log("")
  if (failed) for (const f of res.failed) console.log(`✕ ${f.domain}: ${f.error} Re-run to retry.`)
  else if (res.alreadyOnline.length) console.log(`✓ ${site.domain} was already back online.`)
  else if (res.gone.length) console.log(`${site.domain} no longer exists in SpinupWP; forgotten.`)
  else console.log(`✓ ${site.domain} is back online.`)
  if (res.kumaWindowClosed) console.log("    Uptime Kuma: maintenance window closed; monitoring resumed.")
  return failed ? 1 : 0
}

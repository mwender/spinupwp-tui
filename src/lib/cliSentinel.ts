// `spinuptui sentinel …` — the CLI over Sentinel. Headless like every module
// command: --json prints one result object on stdout, progress goes to stderr,
// failures use the { ok: false, reason, message, remedy? } shape and exit 1.

import { loadConfig, saveConfig, type SentinelStored } from "../config.ts"
import { SpinupWPClient } from "../api/client.ts"
import { moduleWorkDir } from "../modules/contract.ts"
import { sentinelModule } from "../modules/sentinel.ts"
import { BLOCKED_EXIT } from "./schedulerRun.ts"
import { postToBoard } from "./beaconBoard.ts"
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { commitAndPush } from "./schedulerGit.ts"
import { gitRootOf } from "./schedulerJobs.ts"
import { applyAttach, planAttach, type AttachPlan } from "./sentinelAttach.ts"
import { composeDigest, expectDeps, gatherDigest, recordDigest } from "./sentinelDigest.ts"
import { EXPECT_TYPES, loadExpectations, runExpectation, saveExpectations, validateExpectation, type Expectation } from "./sentinelExpect.ts"
import { describeIncident } from "./sentinelReply.ts"
import { clearPause, deleteIncident, loadFlags, loadIncident, loadIncidents, loadPause, loadSeen, loadTickState, logShadow, saveFlags, saveIncident, savePause, saveSeen, saveTickState, sentinelSettings, type Seen } from "./sentinelState.ts"
import { eventMs } from "./sentinelIncidents.ts"
import { realDeps, sendPage, sentinelTick } from "./sentinelTick.ts"
import { realWorkerDeps, runWorker } from "./sentinelWorker.ts"
import { withKuma, type KumaMonitor } from "./uptimeKuma.ts"

const VALUE_FLAGS = new Set(["--for", "--since", "--agent", "--workspace", "--report-to", "--type", "--domain", "--server", "--match", "--min", "--threshold", "--host", "--paths", "--log-glob", "--url", "--expect", "--label", "--note", "--expires"])

const USAGE = `Usage:
  spinuptui sentinel setup [--plan | --apply] [--shadow] [--agent claude|codex|none]
                           [--workspace <dir>] [--report-to <board>]
  spinuptui sentinel attach --plan | --apply [--include-likely]
                           adopt an existing Kuma's monitors; read-only toward Kuma
  spinuptui sentinel status [--json]
  spinuptui sentinel tick [--dry-run]          one check of Kuma (Scheduler runs this)
  spinuptui sentinel digest [--dry-run]        the daily digest (Scheduler runs this)
  spinuptui sentinel list [--open] [--json]
  spinuptui sentinel show <incident>
  spinuptui sentinel diagnose <incident>       queue it; the next tick starts it
  spinuptui sentinel post <incident>           post its report to the board
  spinuptui sentinel pause --for 2h            stop acting on events, up to 7d
  spinuptui sentinel resume
  spinuptui sentinel go-live --since "YYYY-MM-DD HH:MM:SS"
                           leave shadow mode; events after that UTC time are new
  spinuptui sentinel expect list | check <id> | remove <id> | ack <id>
  spinuptui sentinel expect add <id> --type ${EXPECT_TYPES.join("|")} [--domain <d>] [--label <l>] [--note <n>] [--expires YYYY-MM-DD]
      log-count:  --match <text> [--min N] [--trend]
      load-shape: --threshold N
      cache-hit:  --host <canonical host> --paths /,/?one=param
      warmer:     --log-glob <path>
      status:     --url <url> --expect <code>`

interface Parsed {
  positionals: string[]
  flags: Map<string, string>
}

function parse(list: string[]): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (!a.startsWith("--")) positionals.push(a)
    else if (VALUE_FLAGS.has(a)) flags.set(a, list[++i] ?? "")
    else flags.set(a, "")
  }
  return { positionals, flags }
}

function fail(json: boolean, reason: string, message: string, remedy?: string): number {
  if (json) console.log(JSON.stringify({ ok: false, reason, message, ...(remedy ? { remedy } : {}) }))
  else {
    console.error(message)
    if (remedy) console.error(remedy)
  }
  return 1
}

const say = (line: string) => process.stderr.write(`→ ${line}\n`)
const out = (json: boolean, value: object, text: string) => console.log(json ? JSON.stringify(value) : text)

export async function runSentinel(argv: string[]): Promise<number> {
  const p = parse(argv)
  const json = p.flags.has("--json")
  const [sub, ...rest] = p.positionals
  switch (sub) {
    case "setup":
      return setup(p, json)
    case "attach":
      return attach(p, json)
    case "status":
      return status(json)
    case "tick":
      return tickCmd(p, json)
    case "worker":
      return workerCmd()
    case "digest":
      return digestCmd(p, json)
    case "list":
      return list(p, json)
    case "show":
      return show(rest)
    case "diagnose":
      return diagnose(rest, json)
    case "post":
      return post(rest, p, json)
    case "pause":
      return pause(p, json)
    case "resume":
      return resume(json)
    case "go-live":
      return goLive(p, json)
    case "expect":
      return expect(rest, p, json)
  }
  return fail(json, "usage", USAGE)
}

// ---- setup --------------------------------------------------------------------------

interface SetupPlan {
  blockers: string[]
  next: SentinelStored
  notes: string[]
  watching: number
}

export function planSetup(p: { shadow?: boolean; agent?: string; workspace?: string; reportTo?: string }): SetupPlan {
  const cfg = loadConfig()
  const blockers: string[] = []
  const notes: string[] = []
  if (!cfg.beacon?.channels || !Object.keys(cfg.beacon.channels).length) blockers.push("Beacon has no channel: spinuptui beacon setup")
  if (!cfg.scheduler?.dispatcher) blockers.push("Scheduler's dispatcher isn't installed: spinuptui scheduler install --plan")
  if (!cfg.uptimeKuma) blockers.push("No Uptime Kuma connection: press M on a site")
  const watching = Object.keys(cfg.kumaMonitors).length
  if (!watching) notes.push("No monitors are registered yet: run spinuptui sentinel attach --plan.")
  const found = (["claude", "codex"] as const).find((a) => Bun.which(a))
  const agent = p.agent === "none" ? null : ((p.agent as "claude" | "codex" | undefined) ?? cfg.sentinel?.diagnosis?.agent ?? found ?? null)
  if (agent === "codex") notes.push("Codex is unproven here: its read-only sandbox blocks the network that ssh-exec needs.")
  if (!agent) notes.push("No agent: incidents get a write-up of the evidence, not a diagnosis.")
  const reportTo = p.reportTo ?? cfg.sentinel?.reportTo ?? null
  if (reportTo && !cfg.beacon?.boards?.[reportTo]) blockers.push(`No Beacon board named "${reportTo}": spinuptui beacon add basecamp ${reportTo} --project <id>`)
  const next: SentinelStored = {
    ...cfg.sentinel,
    enabled: true,
    mode: p.shadow ? "shadow" : (cfg.sentinel?.mode ?? "live"),
    reportTo,
    ...(p.workspace ? { workspace: p.workspace } : {}),
    diagnosis: { ...cfg.sentinel?.diagnosis, agent },
  }
  return { blockers, next, notes, watching }
}

function setupText(plan: SetupPlan): string {
  const n = plan.next
  return [
    `Sentinel would watch ${plan.watching} domain(s), every 5 minutes, with a digest at 08:00, as Scheduler jobs.`,
    `  mode:      ${n.mode}`,
    `  agent:     ${n.diagnosis?.agent ?? "none"}`,
    `  workspace: ${n.workspace ?? join("~/SpinupTUI", "sentinel")}`,
    `  board:     ${n.reportTo ?? "none"}`,
    ...plan.notes.map((x) => `Note: ${x}`),
    ...plan.blockers.map((x) => `Blocked: ${x}`),
  ].join("\n")
}

// Saves the settings and proves them with one real tick. The TUI uses this too.
export async function applySetup(next: SentinelStored) {
  await saveConfig({ sentinel: next })
  return tick(false)
}

async function setup(p: Parsed, json: boolean): Promise<number> {
  const plan = planSetup({ shadow: p.flags.has("--shadow"), agent: p.flags.get("--agent"), workspace: p.flags.get("--workspace"), reportTo: p.flags.get("--report-to") })
  if (!p.flags.has("--apply")) {
    if (!p.flags.has("--plan") && !json) console.log("Nothing applied. Review this, then run with --apply.\n")
    out(json, { ok: true, ...plan }, setupText(plan))
    return 0
  }
  if (plan.blockers.length) return fail(json, "not_ready", plan.blockers.join("\n"))
  say("Running one real tick")
  const r = await applySetup(plan.next)
  if (!r.ok) return fail(json, r.reason, r.message)
  out(json, r, r.firstRun ? "Sentinel is on: it read Kuma and starts from now." : `Sentinel is on: ${r.events} new event(s).`)
  return 0
}

// ---- attach ---------------------------------------------------------------------------

function attachText(a: AttachPlan, includeLikely: boolean): string {
  const lines = [`${a.exact.length} monitor(s) match by name and would attach; ${a.already} already attached.`]
  if (a.likely.length) lines.push(`${a.likely.length} likely match(es)${includeLikely ? "" : ", attached only with --include-likely"}:`, ...a.likely.map((m) => `  ${m.name} → ${m.domain}`))
  if (a.unmonitored.length) lines.push(`${a.unmonitored.length} site(s) have no monitor: ${a.unmonitored.slice(0, 10).join(", ")}${a.unmonitored.length > 10 ? ", …" : ""}`)
  if (a.strangers.length) lines.push(`${a.strangers.length} Kuma monitor(s) match no site and are ignored.`)
  return lines.join("\n")
}

// What attach would do: reads Kuma and the fleet, changes nothing.
export async function loadAttachPlan(): Promise<{ plan: AttachPlan; monitors: KumaMonitor[] }> {
  const cfg = loadConfig()
  const monitors = (await withKuma(cfg.uptimeKuma!, (k) => k.getMonitors())).result
  const sites = await new SpinupWPClient(cfg).listSites()
  const domains = sites.flatMap((s) => [s.domain, ...(s.additional_domains ?? []).map((d) => d.domain)])
  return { plan: planAttach(monitors, domains, cfg.kumaMonitors, sites.map((s) => s.domain)), monitors }
}

export async function saveAttach(plan: AttachPlan, monitors: KumaMonitor[], includeLikely: boolean): Promise<number> {
  const matches = [...plan.exact, ...(includeLikely ? plan.likely : [])]
  await saveConfig({ kumaMonitors: applyAttach(loadConfig().kumaMonitors, matches, monitors) })
  return matches.length
}

async function attach(p: Parsed, json: boolean): Promise<number> {
  if (!loadConfig().uptimeKuma) return fail(json, "kuma_not_configured", "No Uptime Kuma connection configured in SpinupTUI.")
  const includeLikely = p.flags.has("--include-likely")
  let loaded: Awaited<ReturnType<typeof loadAttachPlan>>
  try {
    loaded = await loadAttachPlan()
  } catch (err) {
    return fail(json, "kuma_error", (err as Error).message)
  }
  const { plan, monitors } = loaded
  if (!p.flags.has("--apply")) {
    out(json, { ok: true, ...plan }, attachText(plan, includeLikely))
    return 0
  }
  const attached = await saveAttach(plan, monitors, includeLikely)
  out(json, { ok: true, attached }, `Attached ${attached} monitor(s). Nothing was changed in Kuma.`)
  return 0
}

// ---- ticks ----------------------------------------------------------------------------

async function tick(dryRun: boolean) {
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  return sentinelTick(sentinelSettings(cfg), realDeps(cfg, client), { dryRun })
}

async function tickCmd(p: Parsed, json: boolean): Promise<number> {
  const s = sentinelSettings(loadConfig())
  const dryRun = p.flags.has("--dry-run")
  if (!s.enabled && !dryRun) return fail(json, "not_configured", "Sentinel isn't set up.", "spinuptui sentinel setup --plan")
  const r = await tick(dryRun)
  console.log(JSON.stringify(r))
  if (r.ok) return 0
  return r.needsPerson ? BLOCKED_EXIT : 1
}

async function workerCmd(): Promise<number> {
  const cfg = loadConfig()
  const s = sentinelSettings(cfg)
  if (!s.enabled || s.shadow) return 0
  await runWorker(s, realWorkerDeps(cfg, s))
  return 0
}

async function digestCmd(p: Parsed, json: boolean): Promise<number> {
  const cfg = loadConfig()
  const s = sentinelSettings(cfg)
  const dryRun = p.flags.has("--dry-run")
  if (!s.enabled && !dryRun) return fail(json, "not_configured", "Sentinel isn't set up.", "spinuptui sentinel setup --plan")
  const data = await gatherDigest(s, cfg, new SpinupWPClient(cfg), { dryRun })
  const digest = composeDigest(data, loadFlags())
  if (dryRun) {
    console.log(digest.text)
    return 0
  }
  if (s.shadow) {
    logShadow(`would send the digest:\n${digest.text}`)
    return 0
  }
  recordDigest(digest, data)
  // Expectations and trends live here even when the workspace is elsewhere.
  const work = moduleWorkDir("sentinel")
  const root = gitRootOf(work)
  if (root) await commitAndPush(root, [relative(root, work)], "sentinel: digest").catch(() => null)
  const sent = await sendPage(cfg, { text: digest.text, silent: digest.silent }, s.channel)
  if (sent === "sent") return 0
  console.error(`The digest wasn't sent: ${sent}`)
  return 1
}

// ---- incidents ------------------------------------------------------------------------

function list(p: Parsed, json: boolean): number {
  const open = p.flags.has("--open")
  const rows = loadIncidents().filter((i) => !open || !i.closedAt)
  if (json) console.log(JSON.stringify({ ok: true, incidents: rows }))
  else if (!rows.length) console.log("No incidents.")
  else for (const i of rows) console.log(`${i.id}  ${describeIncident(i)}`)
  return 0
}

function show(pos: string[]): number {
  const i = pos[0] ? loadIncident(pos[0]) : null
  if (!i) return fail(false, "unknown_incident", `No incident "${pos[0] ?? ""}".`)
  const { evidence, ...rest } = i
  console.log(JSON.stringify(rest, null, 2))
  if (evidence) console.log(`\n${evidence}`)
  return 0
}

function diagnose(pos: string[], json: boolean): number {
  const i = pos[0] ? loadIncident(pos[0]) : null
  if (!i) return fail(json, "unknown_incident", `No incident "${pos[0] ?? ""}".`)
  saveIncident({ ...i, state: "queued", attempts: 0, why: undefined })
  out(json, { ok: true, id: i.id }, `Queued ${i.id}. The next tick starts it.`)
  return 0
}

async function post(pos: string[], p: Parsed, json: boolean): Promise<number> {
  const cfg = loadConfig()
  const s = sentinelSettings(cfg)
  const i = pos[0] ? loadIncident(pos[0]) : null
  if (!i) return fail(json, "unknown_incident", `No incident "${pos[0] ?? ""}".`)
  if (!i.reportPath) return fail(json, "no_report", `${i.id} has no report yet.`)
  if (i.post === "posted") return fail(json, "already_posted", `Already posted: ${i.postUrl}`)
  const board = s.reportTo ? cfg.beacon?.boards?.[s.reportTo] : undefined
  if (!board) return fail(json, "no_board", "No board is configured.", "spinuptui sentinel setup --report-to <board> --apply")
  saveIncident({ ...i, post: "posting" })
  const r = await postToBoard(board, readFileSync(join(s.workspace, i.reportPath), "utf8"))
  if (!r.ok) {
    saveIncident({ ...i, post: "failed", postError: r.message })
    return fail(json, r.reason, r.message)
  }
  saveIncident({ ...i, post: "posted", postId: r.id, postUrl: r.url, postError: undefined })
  out(json, { ok: true, url: r.url }, `Posted: ${r.url}`)
  return 0
}

// ---- pause and go-live -------------------------------------------------------------------

const MAX_PAUSE_MS = 7 * 24 * 3_600_000

export function pauseMs(value: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(value.trim())
  if (!m || !+m[1]!) return null
  const ms = +m[1]! * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]
  return ms <= MAX_PAUSE_MS ? ms : null
}

function pause(p: Parsed, json: boolean): number {
  const ms = pauseMs(p.flags.get("--for") ?? "")
  if (ms === null) return fail(json, "usage", "--for is required, up to 7d: 30m, 2h, 3d.")
  const until = new Date(Date.now() + ms)
  savePause({ until: until.toISOString() })
  out(json, { ok: true, until: until.toISOString() }, `Sentinel is paused until ${until.toLocaleString()}. It resumes by itself.`)
  return 0
}

async function resume(json: boolean): Promise<number> {
  const was = loadPause()
  clearPause()
  out(json, { ok: true, wasPaused: !!was }, was ? `Sentinel is watching again. ${was.events ?? 0} event(s) passed during the pause.` : "Sentinel wasn't paused.")
  return 0
}

// Leaves shadow mode at the exact point the old watcher stopped: everything up to
// `since` was its, everything after is Sentinel's. Shadow records go, and any
// event after that time is forgotten so the next tick treats it as new.
async function goLive(p: Parsed, json: boolean): Promise<number> {
  const since = p.flags.get("--since") ?? ""
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(since)) return fail(json, "usage", '--since "YYYY-MM-DD HH:MM:SS" is required, in UTC: the old watcher\'s lastEventTime.')
  const cfg = loadConfig()
  if (!cfg.sentinel?.enabled) return fail(json, "not_configured", "Sentinel isn't set up.", "spinuptui sentinel setup --plan")
  if (cfg.sentinel.mode !== "shadow") return fail(json, "not_shadow", "Sentinel is already live; go-live only leaves shadow mode.")
  const cutoff = eventMs(since)
  for (const i of loadIncidents()) if (i.state === "shadow" || i.refersTo) deleteIncident(i.id)
  const seen: Seen = {}
  for (const [k, t] of Object.entries(loadSeen())) if (eventMs(t) <= cutoff) seen[k] = t
  saveSeen(seen)
  const ts = loadTickState()
  saveTickState({ ...ts, started: true, lastCleanAt: new Date(cutoff).toISOString() })
  await saveConfig({ sentinel: { ...cfg.sentinel, mode: "live" } })
  out(json, { ok: true, since }, `Sentinel is live. Events after ${since} UTC are its to handle.`)
  return 0
}

// ---- expectations ---------------------------------------------------------------------------

function buildExpectation(id: string, f: Map<string, string>): Expectation {
  const base = {
    id,
    ...(f.get("--domain") ? { domain: f.get("--domain") } : {}),
    ...(f.get("--server") ? { server: f.get("--server") } : {}),
    ...(f.get("--label") ? { label: f.get("--label") } : {}),
    ...(f.get("--note") ? { note: f.get("--note") } : {}),
    ...(f.get("--expires") ? { expires: f.get("--expires") } : {}),
  }
  const n = (name: string) => (f.has(name) ? Number(f.get(name)) : undefined)
  switch (f.get("--type")) {
    case "log-count":
      return { ...base, type: "log-count", match: f.get("--match") ?? "", ...(f.has("--min") ? { min: n("--min") } : {}), ...(f.has("--trend") ? { trend: true } : {}) } as Expectation
    case "load-shape":
      return { ...base, type: "load-shape", threshold: n("--threshold") ?? 0 } as Expectation
    case "cache-hit":
      return { ...base, type: "cache-hit", host: f.get("--host") ?? "", paths: (f.get("--paths") ?? "").split(",").filter(Boolean) } as Expectation
    case "warmer":
      return { ...base, type: "warmer", logGlob: f.get("--log-glob") ?? "" } as Expectation
    default:
      return { ...base, type: f.get("--type") ?? "", url: f.get("--url") ?? "", expect: n("--expect") ?? 0 } as Expectation
  }
}

async function expect(pos: string[], p: Parsed, json: boolean): Promise<number> {
  const [action, id] = pos
  const all = loadExpectations()
  switch (action) {
    case "list":
      if (json) console.log(JSON.stringify({ ok: true, expectations: all }))
      else if (!all.length) console.log("No expectations yet.")
      else for (const e of all) console.log(`${e.id}  ${e.type}  ${e.domain ?? ("url" in e ? e.url : "")}${e.expires ? `  expires ${e.expires}` : ""}${e.label ? `  (${e.label})` : ""}`)
      return 0
    case "add": {
      if (!id) return fail(json, "usage", USAGE)
      const e = buildExpectation(id, p.flags)
      const problems = validateExpectation(e)
      if (all.some((x) => x.id === id)) problems.push(`there's already an expectation named ${id}`)
      if (problems.length) return fail(json, "invalid", problems.join("\n"))
      saveExpectations([...all, e])
      out(json, { ok: true, id }, `Added ${id}. It runs with the next digest; to try it now: spinuptui sentinel expect check ${id}. Saved in ${moduleWorkDir("sentinel")}.`)
      return 0
    }
    case "remove":
      if (!all.some((x) => x.id === id)) return fail(json, "unknown_expectation", `No expectation "${id ?? ""}".`)
      saveExpectations(all.filter((x) => x.id !== id))
      out(json, { ok: true, id }, `Removed ${id}.`)
      return 0
    case "check": {
      const e = all.find((x) => x.id === id)
      if (!e) return fail(json, "unknown_expectation", `No expectation "${id ?? ""}".`)
      const cfg = loadConfig()
      const r = await runExpectation(e, expectDeps(cfg, new SpinupWPClient(cfg)))
      out(json, { ok: true, ...r }, `${r.label}: ${r.state} — ${r.text}`)
      return 0
    }
    case "ack": {
      const flags = loadFlags()
      if (!id || !flags[id]) return fail(json, "unknown_flag", `No flag is set for "${id ?? ""}".`)
      saveFlags({ ...flags, [id]: { ...flags[id]!, acked: true } })
      out(json, { ok: true, id }, `Acknowledged ${id}. It stays counted in the digest until it clears.`)
      return 0
    }
  }
  return fail(json, "usage", USAGE)
}

async function status(json: boolean): Promise<number> {
  const s = await sentinelModule.status()
  const newest = Object.values(loadSeen()).sort().pop() ?? null
  if (json) console.log(JSON.stringify({ ok: true, lastEventTime: newest, ...s }))
  else {
    console.log(`Sentinel: ${s.state} — ${s.summary}`)
    for (const c of s.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
    if (s.remedy) console.log(`  → ${s.remedy}`)
  }
  return 0
}

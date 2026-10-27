// Scheduler's module declaration: the station's clock. Its status is the
// one-question answer to "is the station alive?" — how long ago the dispatcher
// last ticked.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { tryLock } from "../lib/flock.ts"
import { loadConfig } from "../config.ts"
import { beaconFromConfig } from "../lib/beacon.ts"
import { nextRunText, parseWhen } from "../lib/schedule.ts"
import { listSources, loadJobs, loadState, readLastTick, type Source } from "../lib/schedulerJobs.ts"
import { readClaim, stationName } from "../lib/schedulerGit.ts"
import { moduleStateDir, moduleWorkDir, type ModuleCheck, type ModuleDefinition, type ModuleStatus } from "./contract.ts"

// Three missed ticks.
export const TICK_STALE_MS = 15 * 60_000
const RECENT_FAILURE_MS = 24 * 60 * 60_000

function claimText(s: Source): string {
  const holder = readClaim(s)
  if (s.queueOnly) return holder ? `run by ${holder}; released here, this machine only queues` : "released here; this machine only queues"
  if (!holder) return "unclaimed: the next dispatcher tick here claims it"
  return holder === stationName() ? "run by this station" : `run by ${holder}; this machine only queues`
}

function tickRunning(): boolean {
  try {
    const lock = tryLock(join(moduleStateDir("scheduler"), "tick.lock"))
    if (!lock) return true
    lock.release()
  } catch {
    // No lock support: assume nothing is running.
  }
  return false
}

function age(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return "just now"
  if (m < 120) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

export const schedulerModule: ModuleDefinition = {
  id: "scheduler",
  name: "Scheduler",
  summary: "Follow-ups that run themselves: the fix you shipped today gets checked tomorrow without you remembering.",
  dependsOn: ["beacon"],
  configKey: "scheduler",
  stateDir: () => moduleStateDir("scheduler"),
  workDir: () => moduleWorkDir("scheduler"),
  jobs: [],
  async status(): Promise<ModuleStatus> {
    const cfg = loadConfig()
    const d = cfg.scheduler?.dispatcher
    const checks: ModuleCheck[] = []
    const installed = !!d && existsSync(d.unitPath)
    checks.push({
      name: "dispatcher",
      ok: installed,
      detail: installed ? `${d!.label}, every 5 min` : d ? `unit file missing (${d.unitPath})` : "not installed",
    })
    const last = readLastTick()
    const lastAge = last ? Date.now() - Date.parse(last.at) : null
    const fresh = lastAge !== null && lastAge < TICK_STALE_MS
    // A tick still holding its lock is alive: a long agent job can take 30
    // minutes, and the station isn't dead while it runs.
    const running = !fresh && tickRunning()
    checks.push({
      name: "last tick",
      ok: !installed || fresh || running,
      detail:
        (last ? `${age(lastAge!)} (${last.via})${last.errors.length ? `, ${last.errors.length} problem${last.errors.length === 1 ? "" : "s"}: ${last.errors[0]}` : ""}` : "never") +
        (running ? "; a tick is running now" : ""),
    })
    const now = new Date()
    let active = 0
    const failed: string[] = []
    for (const s of listSources(cfg)) {
      const exists = existsSync(s.path)
      // The local folder appears on first use, so its absence is normal.
      if (s.name !== "local" || exists) checks.push({ name: `source ${s.name}`, ok: exists, detail: exists ? `${s.path}${s.git ? ` (git, ${claimText(s)})` : ""}` : `${s.path} does not exist` })
      if (!exists) continue
      for (const j of loadJobs(s)) {
        if (j.problems.length) {
          failed.push(`${s.name}/${j.name} invalid`)
          continue
        }
        const st = loadState(s, j.header.id!)
        let next = "?"
        try {
          next = nextRunText(j.header, st, now)
        } catch {
          // validateJob already accepted it; leave "?".
        }
        if (next !== "expired" && next !== "done") active++
        // A failure was paged when it happened; it stays news for a day, not
        // until the job expires.
        const recent = st.last_run ? now.getTime() - parseWhen(st.last_run).getTime() < RECENT_FAILURE_MS : st.last_status === "auth"
        if (st.last_status && st.last_status !== "ok" && next !== "expired" && recent) failed.push(`${s.name}/${j.header.id} ${st.last_status}`)
      }
    }
    checks.push({ name: "jobs", ok: failed.length === 0, detail: `${active} active${failed.length ? `; not ok in the last day: ${failed.slice(0, 3).join(", ")}` : ""}` })
    const beacon = beaconFromConfig(cfg)
    checks.push({ name: "digests", ok: beacon.channels.length > 0, detail: beacon.channels.length ? `via Beacon (${beacon.defaultChannel ?? "no default"})` : "Beacon isn't set up, so runs aren't reported" })
    const hb = cfg.scheduler?.heartbeat
    const lastHb = last?.heartbeat
    checks.push({
      name: "heartbeat",
      ok: !hb || !lastHb || lastHb.ok,
      detail: !hb
        ? "not set: nothing outside this machine notices if it stops (spinuptui scheduler heartbeat set <kuma-push-url>)"
        : !lastHb
          ? `${new URL(hb.url).host}: first ping on the next dispatcher tick`
          : lastHb.ok
            ? `pinging ${new URL(hb.url).host} every tick (last: ${lastHb.status})`
            : `last ping to ${new URL(hb.url).host} failed: ${lastHb.error}`,
    })

    if (!installed && !d) {
      return {
        id: "scheduler",
        state: "not_configured",
        summary: "Dispatcher not installed",
        checks,
        remedy: "spinuptui scheduler install --plan",
      }
    }
    const failing = checks.find((c) => !c.ok)
    return {
      id: "scheduler",
      state: failing ? "degraded" : "ok",
      summary: failing ? `${failing.name}: ${failing.detail}` : `ticking (${checks[1]!.detail.split(" (")[0]}), ${active} active job${active === 1 ? "" : "s"}`,
      checks,
      ...(failing ? { remedy: failing.name === "dispatcher" || failing.name === "last tick" ? "spinuptui scheduler install --apply" : "spinuptui scheduler list" } : {}),
    }
  },
}

// The next few follow-ups due, soonest first, for the Modules screen.
export function upcomingRuns(limit = 5): { source: string; id: string; next: string }[] {
  const now = new Date()
  const out: { source: string; id: string; next: string }[] = []
  for (const s of listSources(loadConfig())) {
    if (!existsSync(s.path)) continue
    for (const j of loadJobs(s)) {
      if (j.problems.length) continue
      try {
        const next = nextRunText(j.header, loadState(s, j.header.id!), now)
        if (next !== "expired" && next !== "done") out.push({ source: s.name, id: j.header.id!, next })
      } catch {
        // Skip a job whose schedule can't be read.
      }
    }
  }
  // Fixed times sort before "every N min", which has no single next time.
  return out.sort((a, b) => (a.next.startsWith("every") ? 1 : 0) - (b.next.startsWith("every") ? 1 : 0) || a.next.localeCompare(b.next)).slice(0, limit)
}

// Background WordPress core updates — one site at a time (the `u` → WordPress
// flow) or a whole version group at once (`u` on a Stacks version row).
//
// Both live in module-level stores rather than React state, so closing an
// overlay never abandons SSH work in flight: the rows keep their markers, a toast
// reports the outcome, and reopening the overlay picks the job back up. Every
// update — single or bulk — goes through the same per-site job map, which is what
// the list rows' WpCoreRowMark reads.

import { useSyncExternalStore } from "react"
import { theme } from "../lib/theme.ts"
import { Spinner } from "./components.tsx"
import { toast } from "./toast.ts"
import type { Server, Site } from "../api/types.ts"
import { updateWpCore, type WpCoreUpdateResult } from "../lib/wpCore.ts"

// ---- per-site jobs ------------------------------------------------------------

export interface CoreJob {
  version: string
  result: WpCoreUpdateResult | null // null while running
}

let jobs = new Map<number, CoreJob>()
const jobListeners = new Set<() => void>()
const subscribeJobs = (l: () => void) => {
  jobListeners.add(l)
  return () => jobListeners.delete(l)
}

export function setCoreJob(siteId: number, job: CoreJob | null) {
  jobs = new Map(jobs)
  if (job) jobs.set(siteId, job)
  else jobs.delete(siteId)
  for (const l of jobListeners) l()
}

// Every site's job, live — for list views deciding row layout (renderRow isn't a
// component, so it can't call the per-site hook).
export function useWpCoreJobs(): ReadonlyMap<number, CoreJob> {
  return useSyncExternalStore(subscribeJobs, () => jobs)
}

// The job for one site, live.
export function useWpCoreJob(siteId: number): CoreJob | undefined {
  return useSyncExternalStore(subscribeJobs, () => jobs.get(siteId))
}

type NoteVersion = (site: Site, version: string) => void

// Run one site's update as a tracked job. Rows show the cached probe's WP
// version, so a success hands them the version we just verified.
async function runCoreJob(server: Server, site: Site, sshUser: string | null, version: string, multisite: boolean, noteVersion: NoteVersion) {
  setCoreJob(site.id, { version, result: null })
  const result = await updateWpCore(server, site, sshUser, version, multisite)
  setCoreJob(site.id, { version, result })
  if (result.ok) noteVersion(site, result.after)
  return result
}

// The single-site flow: fire and forget, with a toast per outcome.
export function startCoreUpdate(server: Server, site: Site, sshUser: string | null, version: string, multisite: boolean, noteVersion: NoteVersion) {
  void runCoreJob(server, site, sshUser, version, multisite, noteVersion).then((result) => {
    if (result.ok) toast.success(`${site.domain} updated to WordPress ${result.after}`)
    else toast.error(`WordPress update failed on ${site.domain} — press u to see why`)
  })
}

// Row marker while a site's core update runs (spinner + target) or after it
// failed (stays until the result is viewed in `u` → WordPress, like PHP's ⬆!).
// Renders nothing otherwise. `compact` is for rows with no WP-version column.
export function WpCoreRowMark({ siteId, selected, compact = false }: { siteId: number; selected: boolean; compact?: boolean }) {
  const job = useWpCoreJob(siteId)
  if (!job || job.result?.ok) return null
  if (job.result === null) {
    return (
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        <Spinner color={selected ? theme.text : theme.brand} interval={120} />
        <text content={compact ? "WP " : ` → WP ${job.version}`} fg={selected ? theme.text : theme.warn} wrapMode="none" />
      </box>
    )
  }
  return <text content={compact ? "WP! " : " ⬆!"} fg={selected ? theme.text : theme.bad} wrapMode="none" style={{ flexShrink: 0 }} />
}

// ---- bulk runs ----------------------------------------------------------------
//
// Canary first, always: the first site in the plan updates alone, and if it fails
// nothing else is touched. Then the rest run MAX_PARALLEL at a time, never two on
// the same server (a core update is download + unzip + DB upgrade — cheap alone,
// not when stacked on one box). After MAX_FAILURES failures no new sites start;
// the ones already running finish. Only one bulk run exists at a time.

export const BULK_MAX_PARALLEL = 4
export const BULK_MAX_FAILURES = 3

export interface BulkItem {
  site: Site
  server: Server
  from: string
  to: string
  multisite: boolean
  composer: boolean // core is Composer-managed (Bedrock/Radicle) — the lock will still pin `from`
  state: "queued" | "running" | "done" | "failed" | "notRun"
  error?: string
}

export interface BulkRun {
  title: string // e.g. "Standard WP · WP 7.0.2"
  items: BulkItem[] // items[0] is the canary
  phase: "canary" | "running" | "stopping" | "done"
  stopReason?: string
}

let bulk: BulkRun | null = null
const bulkListeners = new Set<() => void>()
const subscribeBulk = (l: () => void) => {
  bulkListeners.add(l)
  return () => bulkListeners.delete(l)
}
const emitBulk = () => {
  for (const l of bulkListeners) l()
}
let stopRequested = false

export function useBulkRun(): BulkRun | null {
  return useSyncExternalStore(subscribeBulk, () => bulk)
}

function patchBulk(update: Partial<BulkRun>) {
  if (!bulk) return
  bulk = { ...bulk, ...update }
  emitBulk()
}

function patchItem(index: number, update: Partial<BulkItem>) {
  if (!bulk) return
  const items = bulk.items.slice()
  items[index] = { ...items[index], ...update }
  bulk = { ...bulk, items }
  emitBulk()
}

// Ask a running bulk to start no more sites; the ones in flight finish.
export function stopBulk() {
  if (!bulk || bulk.phase === "done") return
  stopRequested = true
  patchBulk({ phase: "stopping", stopReason: "Stopped by you — sites already updating were allowed to finish." })
}

// The current run, outside React — for key handlers deciding what `u` opens.
export function peekBulk(): BulkRun | null {
  return bulk
}

// Forget a finished run (the summary has been seen).
export function clearBulk() {
  if (bulk?.phase !== "done") return
  bulk = null
  emitBulk()
}

export function startBulkCoreUpdate(
  title: string,
  plan: Omit<BulkItem, "state" | "error">[],
  sshUser: string | null,
  noteVersion: NoteVersion,
) {
  if (plan.length === 0 || (bulk && bulk.phase !== "done")) return
  stopRequested = false
  bulk = { title, items: plan.map((p) => ({ ...p, state: "queued" })), phase: "canary" }
  emitBulk()

  const runOne = async (index: number): Promise<boolean> => {
    const it = bulk!.items[index]
    patchItem(index, { state: "running" })
    const result = await runCoreJob(it.server, it.site, sshUser, it.to, it.multisite, noteVersion)
    if (result.ok) {
      // Success needs no lingering per-site job (the row already shows the new
      // version); a failure keeps its job so the row's ⬆! points at the reason.
      setCoreJob(it.site.id, null)
      patchItem(index, { state: "done" })
    } else {
      patchItem(index, { state: "failed", error: result.error })
    }
    return result.ok
  }

  const finish = (stopReason?: string) => {
    if (!bulk) return
    const items = bulk.items.map((it) => (it.state === "queued" ? { ...it, state: "notRun" as const } : it))
    bulk = { ...bulk, items, phase: "done", stopReason: stopReason ?? bulk.stopReason }
    emitBulk()
    const done = items.filter((i) => i.state === "done").length
    const failed = items.filter((i) => i.state === "failed").length
    const notRun = items.filter((i) => i.state === "notRun").length
    const tail = [failed ? `${failed} failed` : "", notRun ? `${notRun} not run` : ""].filter(Boolean).join(", ")
    const msg = `${title}: ${done} of ${items.length} updated${tail ? ` · ${tail}` : ""}`
    if (failed || notRun) toast.error(`${msg} — press u on the group for details`)
    else toast.success(msg)
  }

  void (async () => {
    if (!(await runOne(0))) return finish("The canary failed, so no other site was touched.")
    if (stopRequested) return finish()
    patchBulk({ phase: "running" })

    await new Promise<void>((resolve) => {
      const busyServers = new Set<number>()
      let active = 0
      let failures = 0
      const pump = () => {
        if (!stopRequested && failures >= BULK_MAX_FAILURES && bulk?.phase !== "stopping") {
          patchBulk({ phase: "stopping", stopReason: `Stopped after ${BULK_MAX_FAILURES} failures — sites already updating were allowed to finish.` })
        }
        const halted = stopRequested || failures >= BULK_MAX_FAILURES
        for (let i = 1; !halted && active < BULK_MAX_PARALLEL && i < bulk!.items.length; i++) {
          const it = bulk!.items[i]
          if (it.state !== "queued" || busyServers.has(it.server.id)) continue
          busyServers.add(it.server.id)
          active++
          void runOne(i).then((ok) => {
            if (!ok) failures++
            busyServers.delete(it.server.id)
            active--
            pump()
          })
        }
        if (active === 0) resolve()
      }
      pump()
    })
    finish()
  })()
}

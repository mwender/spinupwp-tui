import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncidentEvent, IncidentsResult } from "./cliIncidents.ts"
import { DEFAULT_ALLOW, loadIncidents, loadPause, loadSeen, loadTickState, saveFleet, saveIncident, savePause, saveTickState, type Incident, type SentinelSettings } from "./sentinelState.ts"
import { sentinelTick, type TickDeps } from "./sentinelTick.ts"

const settings = (over: Partial<SentinelSettings> = {}): SentinelSettings => ({ enabled: true, shadow: false, channel: null, reportTo: null, workspace: "/tmp/x", recurrenceHours: 6, maxDiagnosesPerDay: 15, agent: "claude", model: null, timeoutMin: 30, allow: DEFAULT_ALLOW, ...over })
const now = new Date("2026-10-30T14:00:00Z")
const down = (domain: string, monitorId: number, time = "2026-10-30 13:58:00.000"): IncidentEvent => ({ domain, kind: "health", status: "down", time, message: "", monitorId })
const ok = (events: IncidentEvent[], failedMonitors: string[] = []): IncidentsResult => ({ ok: true, windowHours: 1, events, failedMonitors, kumaAlerted: [] })

function harness(results: IncidentsResult[], over: Partial<TickDeps> = {}) {
  const pages: string[] = []
  const started: number[] = []
  const slept: number[] = []
  let call = 0
  const deps: TickDeps = {
    incidents: async () => results[Math.min(call++, results.length - 1)]!,
    page: async (p) => (pages.push(p.text), "sent"),
    refreshFleet: async () => null,
    startWorker: () => started.push(1),
    workerRunning: () => false,
    sleep: async (ms) => slept.push(ms),
    now: () => now,
    ...over,
  }
  return { deps, pages, started, slept }
}

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sentinel-t-"))
  process.env.SPINUPTUI_HOME = mkdtempSync(join(tmpdir(), "sentinel-th-"))
  saveFleet({ fetchedAt: now.toISOString(), domains: { "a.example.com": { server: "web1", site: "a.example.com" } } })
})

const begun = () => saveTickState({ started: true, lastCleanAt: "2026-10-30T13:55:00Z" })

describe("the first tick", () => {
  test("marks history as seen rather than paging for it", async () => {
    const h = harness([ok([down("a.example.com", 1)])])
    expect(await sentinelTick(settings(), h.deps)).toMatchObject({ ok: true, firstRun: true })
    expect(h.pages).toEqual([])
    expect(loadIncidents()).toEqual([])
    expect(Object.keys(loadSeen()).length).toBe(1)
  })
})

describe("a normal tick", () => {
  test("a new down event pages, queues and starts the worker, once", async () => {
    begun()
    const h = harness([ok([down("a.example.com", 1)])])
    expect(await sentinelTick(settings(), h.deps)).toMatchObject({ ok: true, events: 1, incidents: 1, started: true })
    expect(h.pages.length).toBe(1)
    expect(h.started.length).toBe(1)
    expect(loadIncidents()[0]!.state).toBe("queued")
    await sentinelTick(settings(), h.deps)
    expect(h.pages.length).toBe(1)
    expect(loadIncidents().length).toBe(1)
  })

  test("doesn't start a second worker", async () => {
    begun()
    const h = harness([ok([down("a.example.com", 1)])], { workerRunning: () => true })
    await sentinelTick(settings(), h.deps)
    expect(h.started).toEqual([])
  })

  test("a monitor that couldn't be read keeps the window open, and its event still arrives", async () => {
    begun()
    const late = down("b.example.com", 2, "2026-10-30 13:40:00.000")
    const h = harness([ok([down("a.example.com", 1)], ["b.example.com health"]), ok([down("a.example.com", 1), late])])
    await sentinelTick(settings(), h.deps)
    expect(loadTickState().lastCleanAt).toBe("2026-10-30T13:55:00Z")
    await sentinelTick(settings(), h.deps)
    expect(loadIncidents().map((i) => i.key).sort()).toEqual(["b.example.com", "web1"])
    expect(loadTickState().lastCleanAt).toBe(now.toISOString())
  })
})

describe("when Kuma can't be read", () => {
  const bad: IncidentsResult = { ok: false, reason: "kuma_error", message: "websocket error" }

  test("a cold start recovers without saying anything", async () => {
    begun()
    const h = harness([bad, ok([])])
    expect((await sentinelTick(settings(), h.deps)).ok).toBe(true)
    expect(h.slept.length).toBe(1)
    expect(h.pages).toEqual([])
  })

  test("after three failures it's blind, and exits so Scheduler pages", async () => {
    begun()
    const h = harness([bad])
    expect(await sentinelTick(settings(), h.deps)).toMatchObject({ ok: false, needsPerson: false })
    expect(h.slept.length).toBe(2)
    expect(loadTickState().blindSince).toBeTruthy()
  })

  test("what's already queued still starts", async () => {
    begun()
    saveIncident({ id: "q", key: "k", server: null, state: "queued", createdAt: now.toISOString(), events: [], down: [], lastDownAt: now.toISOString(), attempts: 0 })
    const h = harness([bad])
    await sentinelTick(settings(), h.deps)
    expect(h.started.length).toBe(1)
  })

  test("a configuration problem needs a person, and isn't retried", async () => {
    begun()
    const h = harness([{ ok: false, reason: "no_monitors_registered", message: "none" }])
    expect(await sentinelTick(settings(), h.deps)).toMatchObject({ ok: false, needsPerson: true })
    expect(h.slept).toEqual([])
  })
})

describe("recovering work", () => {
  const stale = (over: Partial<Incident>): Incident => ({ id: "x", key: "web1", server: "web1", state: "diagnosing", createdAt: now.toISOString(), events: [{ domain: "a.example.com", kind: "health", time: "t", message: "", monitorId: 1 }], down: [1], lastDownAt: now.toISOString(), attempts: 1, ...over })

  test("a crashed worker's incident is requeued, then failed", async () => {
    begun()
    saveIncident(stale({}))
    const h = harness([ok([])])
    await sentinelTick(settings(), h.deps)
    expect(loadIncidents()[0]!.state).toBe("queued")
    expect(h.started.length).toBe(1)
    saveIncident(stale({ attempts: 2 }))
    await sentinelTick(settings(), h.deps)
    expect(loadIncidents()[0]!.state).toBe("failed")
  })

  test("a live worker's incident is left alone", async () => {
    begun()
    saveIncident(stale({}))
    await sentinelTick(settings(), harness([ok([])], { workerRunning: () => true }).deps)
    expect(loadIncidents()[0]!.state).toBe("diagnosing")
  })

  test("a login wait retries when it's due", async () => {
    begun()
    saveIncident(stale({ state: "waiting_agent", retryAfter: "2026-10-30T13:59:00Z" }))
    await sentinelTick(settings(), harness([ok([])]).deps)
    expect(loadIncidents()[0]!.state).toBe("queued")
  })

  test("a post cut off midway isn't retried: it asks a person", async () => {
    begun()
    saveIncident(stale({ state: "reported", post: "posting" }))
    const h = harness([ok([])])
    await sentinelTick(settings(), h.deps)
    expect(loadIncidents()[0]!.post).toBe("unknown")
    expect(h.pages[0]).toContain("may or may not exist")
    await sentinelTick(settings(), h.deps)
    expect(h.pages.length).toBe(1)
  })
})

describe("the daily cap", () => {
  test("pages once and doesn't start the worker", async () => {
    begun()
    saveIncident({ id: "d", key: "z", server: null, state: "reported", createdAt: now.toISOString(), events: [], down: [], lastDownAt: now.toISOString(), attempts: 1, startedAt: now.toISOString() })
    const h = harness([ok([down("a.example.com", 1)])])
    await sentinelTick(settings({ maxDiagnosesPerDay: 1 }), h.deps)
    expect(h.started).toEqual([])
    expect(h.pages.some((p) => p.includes("limit"))).toBe(true)
    await sentinelTick(settings({ maxDiagnosesPerDay: 1 }), h.deps)
    expect(h.pages.filter((p) => p.includes("limit")).length).toBe(1)
  })
})

describe("a pause", () => {
  test("marks events seen without acting, and says so when it ends", async () => {
    begun()
    savePause({ until: "2026-10-30T15:00:00Z" })
    const h = harness([ok([down("a.example.com", 1)])])
    expect(await sentinelTick(settings(), h.deps)).toMatchObject({ paused: true })
    expect(h.pages).toEqual([])
    expect(loadIncidents()).toEqual([])
    expect(loadPause()!.events).toBe(1)
    const later = harness([ok([down("a.example.com", 1)])], { now: () => new Date("2026-10-30T15:05:00Z") })
    await sentinelTick(settings(), later.deps)
    expect(loadPause()).toBeNull()
    expect(loadIncidents()).toEqual([])
    expect(later.pages[0]).toContain("watching again")
  })
})

describe("shadow mode", () => {
  test("pages nothing, starts nothing, and records what it would do", async () => {
    begun()
    const h = harness([ok([down("a.example.com", 1)])])
    await sentinelTick(settings({ shadow: true }), h.deps)
    expect(h.pages).toEqual([])
    expect(h.started).toEqual([])
    expect(loadIncidents()[0]!.state).toBe("shadow")
  })

  test("going blind in shadow mode doesn't page", async () => {
    begun()
    const h = harness([{ ok: false, reason: "kuma_error", message: "x" }])
    expect((await sentinelTick(settings({ shadow: true }), h.deps)).ok).toBe(true)
  })
})

test("a dry run changes nothing", async () => {
  begun()
  const h = harness([ok([down("a.example.com", 1)])])
  const before = loadTickState()
  expect(await sentinelTick(settings(), h.deps, { dryRun: true })).toMatchObject({ ok: true, incidents: 1 })
  expect(h.pages).toEqual([])
  expect(loadIncidents()).toEqual([])
  expect(loadTickState()).toEqual(before)
  expect(loadSeen()).toEqual({})
})

import { describe, expect, test } from "bun:test"
import type { IncidentEvent, IncidentKind, IncidentStatus } from "./cliIncidents.ts"
import { applyEvents, closeIncidents, eventMs, markSeen, newEvents, startedToday, windowHours, type ApplyInput } from "./sentinelIncidents.ts"
import { seenKey, type Fleet, type Incident } from "./sentinelState.ts"

const fleet: Fleet = { domains: { "a.example.com": { server: "web1", site: "a.example.com" }, "b.example.com": { server: "web1", site: "b.example.com" }, "c.example.com": { server: "web2", site: "c.example.com" } } }
const now = new Date("2026-10-30T14:00:00Z")

let nextId = 1
function ev(domain: string, status: IncidentStatus = "down", kind: IncidentKind = "health", time = "2026-10-30 13:58:00.000", monitorId?: number): IncidentEvent {
  return { domain, kind, status, time, message: "", monitorId: monitorId ?? nextId++ }
}

const apply = (over: Partial<ApplyInput> & { events: IncidentEvent[] }) =>
  applyEvents({ incidents: [], fleet, now, recurrenceHours: 6, hasAgent: true, shadow: false, kumaAlerted: new Set(), ...over })

describe("the seen-set", () => {
  test("finds an old event a newer one would have hidden from a timestamp", () => {
    const newer = ev("a.example.com", "down", "health", "2026-10-30 13:50:00.000", 1)
    const older = ev("b.example.com", "down", "health", "2026-10-30 13:40:00.000", 2)
    const seen = markSeen({}, [newer], now)
    expect(newEvents([older, newer], seen)).toEqual([older])
  })

  test("two monitors can share a timestamp", () => {
    const a = ev("a.example.com", "down", "health", "2026-10-30 13:50:00.000", 1)
    const b = ev("a.example.com", "down", "redis", "2026-10-30 13:50:00.000", 2)
    expect(newEvents([a, b], markSeen({}, [a], now))).toEqual([b])
  })

  test("drops what's past the longest window", () => {
    const old = ev("a.example.com", "down", "health", "2026-10-20 13:50:00.000", 1)
    expect(markSeen({ [seenKey(old)]: old.time }, [], now)).toEqual({})
  })

  test("the window reaches back to the last clean tick, within limits", () => {
    expect(windowHours(undefined, now)).toBe(1)
    expect(windowHours("2026-10-30T13:55:00Z", now)).toBe(2)
    expect(windowHours("2026-10-29T13:55:00Z", now)).toBe(26)
    expect(windowHours("2026-09-01T00:00:00Z", now)).toBe(168)
  })

  test("reads Kuma's zoneless times as UTC", () => {
    expect(eventMs("2026-10-30 13:34:05.123")).toBe(Date.parse("2026-10-30T13:34:05.123Z"))
  })
})

describe("grouping", () => {
  test("down events on one server are one incident, with one page", () => {
    const r = apply({ events: [ev("a.example.com"), ev("b.example.com"), ev("c.example.com")] })
    expect(r.created.map((i) => i.key).sort()).toEqual(["web1", "web2"])
    expect(r.pages.length).toBe(2)
    expect(r.pages[0]!.text).toContain("a.example.com, b.example.com")
  })

  test("a domain outside the fleet is its own incident, and asks for a refresh", () => {
    const r = apply({ events: [ev("other.example.org")] })
    expect(r.created[0]!.key).toBe("other.example.org")
    expect(r.unknownDomains).toEqual(["other.example.org"])
  })

  test("joining an open incident pages once silently, and queues nothing new", () => {
    const first = apply({ events: [ev("a.example.com")] })
    const later = apply({ incidents: first.created, events: [ev("b.example.com")] })
    expect(later.created).toEqual([])
    expect(later.pages).toMatchObject([{ silent: true }])
    expect(later.pages[0]!.text).toContain("joined")
    const again = apply({ incidents: first.created, events: [ev("b.example.com", "down", "redis")] })
    expect(again.pages).toEqual([])
  })

  test("the first page is silent only when Kuma alerted for every monitor", () => {
    const a = ev("a.example.com", "down", "health", undefined, 7)
    const b = ev("b.example.com", "down", "health", undefined, 8)
    expect(apply({ events: [a, b], kumaAlerted: new Set([7, 8]) }).pages[0]!.silent).toBe(true)
    expect(apply({ events: [a, b], kumaAlerted: new Set([7]) }).pages[0]!.silent).toBe(false)
  })

  test("without an agent the page says so", () => {
    expect(apply({ events: [ev("a.example.com")], hasAgent: false }).pages[0]!.text).toContain("no agent")
  })
})

describe("closing", () => {
  test("every monitor back, then 30 quiet minutes", () => {
    const down = ev("a.example.com", "down", "health", undefined, 1)
    const [i] = apply({ events: [down] }).created
    expect(closeIncidents([i!], new Date(now.getTime() + 3_600_000))).toEqual([])
    apply({ incidents: [i!], events: [ev("a.example.com", "up", "health", "2026-10-30 14:00:00.000", 1)] })
    expect(i!.down).toEqual([])
    expect(closeIncidents([i!], new Date(now.getTime() + 60_000))).toEqual([])
    expect(closeIncidents([i!], new Date(now.getTime() + 31 * 60_000)).length).toBe(1)
  })

  test("a monitor that never comes back can't hold it open for ever", () => {
    const [i] = apply({ events: [ev("a.example.com")] }).created
    expect(closeIncidents([i!], new Date(now.getTime() + 8 * 24 * 3_600_000)).length).toBe(1)
  })
})

describe("recurrence", () => {
  const reported = (at: Date): Incident => {
    const [i] = apply({ events: [ev("a.example.com")], now: at }).created
    return { ...i!, state: "reported", reportedAt: at.toISOString(), reportPath: "sites/a/incidents/x.md", closedAt: at.toISOString() }
  }

  test("a report in the window means no new diagnosis, and a way to ask for one", () => {
    const r = apply({ incidents: [reported(new Date(now.getTime() - 3_600_000))], events: [ev("a.example.com")] })
    expect(r.created[0]!.state).toBe("recurrence")
    expect(r.pages[0]).toMatchObject({ silent: true })
    expect(r.pages[0]!.text).toContain("sites/a/incidents/x.md")
    expect(r.pages[0]!.buttons![0]![0]).toMatchObject({ action: "sentinel.diagnose" })
  })

  test("outside the window, or for another kind, it's a new incident", () => {
    const old = reported(new Date(now.getTime() - 7 * 3_600_000))
    expect(apply({ incidents: [old], events: [ev("a.example.com")] }).created[0]!.state).toBe("queued")
    const recent = reported(new Date(now.getTime() - 3_600_000))
    expect(apply({ incidents: [recent], events: [ev("a.example.com", "down", "redis")] }).created[0]!.state).toBe("queued")
  })

  test("a failed diagnosis doesn't cover anything", () => {
    const failed: Incident = { ...reported(new Date(now.getTime() - 3_600_000)), state: "failed" }
    expect(apply({ incidents: [failed], events: [ev("a.example.com")] }).created[0]!.state).toBe("queued")
  })

  test("the third in 24 hours makes a sound", () => {
    const base = reported(new Date(now.getTime() - 3_600_000))
    const rec = (n: number): Incident => ({ ...base, id: `r${n}`, state: "recurrence", refersTo: base.id, createdAt: new Date(now.getTime() - n * 3_600_000).toISOString() })
    expect(apply({ incidents: [base, rec(1)], events: [ev("a.example.com")] }).pages[0]!.silent).toBe(true)
    expect(apply({ incidents: [base, rec(1), rec(2)], events: [ev("a.example.com")] }).pages[0]!.silent).toBe(false)
  })
})

describe("shadow mode", () => {
  test("records what would have been queued", () => {
    expect(apply({ events: [ev("a.example.com")], shadow: true }).created[0]!.state).toBe("shadow")
  })
})

test("the cap counts today's starts", () => {
  const i = apply({ events: [ev("a.example.com")] }).created[0]!
  expect(startedToday([{ ...i, startedAt: now.toISOString() }, i], now)).toBe(1)
  expect(startedToday([{ ...i, startedAt: "2026-10-01T00:00:00Z" }], now)).toBe(0)
})

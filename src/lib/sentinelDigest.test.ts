import { describe, expect, test } from "bun:test"
import type { SpinupWPClientLike } from "../api/client.ts"
import { aptTargets, cachedClient, composeDigest, type DigestData } from "./sentinelDigest.ts"
import type { ExpectResult } from "./sentinelExpect.ts"
import type { Flags, Incident } from "./sentinelState.ts"

const when = new Date("2026-10-30T12:00:00")
const flag = (id: string, text = "LOW"): ExpectResult => ({ id, label: id, state: "flag", text })
const data = (over: Partial<DigestData> = {}): DigestData => ({ when, health: [{ name: "Station", ok: true, detail: "ticking" }], ticks: [], incidents: [], results: [], aptTotal: 0, apt: [], notes: [], ...over })

describe("the header reacts to what's new", () => {
  test("all clear is green and silent", () => {
    const d = composeDigest(data(), {})
    expect(d.text.startsWith("✅ Fleet OK")).toBe(true)
    expect(d.silent).toBe(true)
  })

  test("a new flag makes a sound, and records the day", () => {
    const d = composeDigest(data({ results: [flag("a")] }), {})
    expect(d.text.startsWith("⚠️ 1 new")).toBe(true)
    expect(d.silent).toBe(false)
    expect(d.text).toContain("New:")
    expect(d.flags.a!.firstSeen).toBe("2026-10-30")
  })

  test("yesterday's flag is ongoing, with its age, and stays quiet", () => {
    const flags: Flags = { a: { firstSeen: "2026-10-18", text: "a: LOW" } }
    const d = composeDigest(data({ results: [flag("a")] }), flags)
    expect(d.text.startsWith("✅ Fleet OK")).toBe(true)
    expect(d.silent).toBe(true)
    expect(d.text).toContain("Ongoing:")
    expect(d.text).toContain("(12 days)")
  })

  test("an acknowledged flag becomes a count, and is never hidden", () => {
    const d = composeDigest(data({ results: [flag("a")] }), { a: { firstSeen: "2026-10-18", text: "x", acked: true } })
    expect(d.text).toContain("1 acknowledged flag still set")
    expect(d.text).not.toContain("Ongoing:")
  })

  test("a flag that clears starts over if it comes back", () => {
    const d = composeDigest(data({ results: [{ id: "a", label: "a", state: "ok", text: "fine" }] }), { a: { firstSeen: "2026-10-18", text: "x" } })
    expect(d.flags).toEqual({})
  })

  test("a check that couldn't run keeps its flag's age", () => {
    const d = composeDigest(data({ results: [{ id: "a", label: "a", state: "unverified", text: "no count" }] }), { a: { firstSeen: "2026-10-18", text: "x" } })
    expect(d.flags.a!.firstSeen).toBe("2026-10-18")
  })

  test("a failing health check makes a sound", () => {
    const d = composeDigest(data({ health: [{ name: "Agent", ok: false, detail: "login lapsed" }] }), {})
    expect(d.text.startsWith("⚠️ Needs attention")).toBe(true)
    expect(d.silent).toBe(false)
    expect(d.text).toContain("Agent: ⚠️ login lapsed")
  })
})

test("a stuck incident is named", () => {
  const i: Incident = { id: "old", key: "k", server: null, state: "waiting_agent", createdAt: new Date(when.getTime() - 2 * 86_400_000).toISOString(), events: [{ domain: "a.example.com", kind: "health", time: "t", message: "", monitorId: 1 }], down: [], lastDownAt: "", attempts: 0 }
  const d = composeDigest(data({ incidents: [i] }), {})
  expect(d.silent).toBe(false)
  expect(d.text).toContain("old: waiting_agent")
})

test("activity counts, and recurrences by site", () => {
  const base: Incident = { id: "x", key: "k", server: null, state: "reported", createdAt: when.toISOString(), events: [{ domain: "a.example.com", kind: "health", time: "t", message: "", monitorId: 1 }], down: [], lastDownAt: "", attempts: 1 }
  const d = composeDigest(data({ incidents: [base, { ...base, id: "y", state: "recurrence" }, { ...base, id: "z", state: "recurrence" }], ticks: [{ at: "", ok: true, events: 0, incidents: 0, retries: 1 }, { at: "", ok: false, events: 0, incidents: 0, retries: 2 }] }), {})
  expect(d.text).toContain("2 checks · 1 incident · 1 report · 2 recurrences · 1 blind · 1 cold start")
  expect(d.text).toContain("a.example.com ×2")
})

test("server updates collapse to a count, naming only the exceptions", () => {
  const apt: ExpectResult[] = [{ id: "apt-a", label: "a", state: "ok", text: "" }, { id: "apt-b", label: "b", state: "unverified", text: "" }, flag("apt-c", "STALE")]
  const d = composeDigest(data({ apt, aptTotal: 3 }), {})
  expect(d.text).toContain("Server updates: 1 of 3 normal, unverified: b")
  expect(d.text).toContain("apt-c: STALE")
})

test("the update check tries one site per server, the one that worked last", () => {
  const fleet = { domains: { "a.example.com": { server: "w1", site: "a.example.com" }, "b.example.com": { server: "w1", site: "b.example.com" }, "www.b.example.com": { server: "w1", site: "b.example.com" }, "w2.example.com": { server: "w2", site: "w2.example.com", vanity: true }, "c.example.com": { server: "w2", site: "c.example.com" } } }
  expect(aptTargets(fleet, { w1: "b.example.com" }, new Set(["c.example.com"]))).toEqual([{ server: "w1", domain: "b.example.com" }, { server: "w2", domain: "c.example.com" }])
})

test("one digest asks the API about the fleet once", async () => {
  let calls = 0
  const client = { listSites: async (id?: number) => (calls++, [{ id }]), listServers: async () => (calls++, []), getSite: async () => (calls++, {}) } as unknown as SpinupWPClientLike
  const c = cachedClient(client)
  await Promise.all([c.listSites(), c.listSites(), c.listSites(1), c.listSites(1), c.listServers(), c.listServers()])
  expect(calls).toBe(3)
  await c.getSite(1)
  await c.getSite(1)
  expect(calls).toBe(5)
})

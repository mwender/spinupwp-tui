import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppConfig } from "../config.ts"
import type { Event, Server, Site } from "../api/types.ts"
import type { SpinupWPClientLike } from "../api/client.ts"
import { bringServerOnline, loadOfflineState, matchServer, takeServerOffline, waitForEvents } from "./offline.ts"

const server = { id: 1, name: "web1.example.com", ip_address: "203.0.113.10" } as Server
const cfg = { profileId: "default", uptimeKuma: null, kumaMonitors: {} } as unknown as AppConfig

function site(id: number, domain: string, disabled = false): Site {
  return { id, server_id: 1, domain, disabled_at: disabled ? "2026-10-01T00:00:00Z" : null } as Site
}

// A fake SpinupWP: disable/enable flip disabled_at and queue an event that is
// "deployed" on the first read, except for sites listed in `failOn`.
function fakeClient(sites: Site[], failOn: number[] = []) {
  const events: Event[] = []
  const calls: string[] = []
  let nextId = 100
  const push = (siteId: number, verb: string) => {
    const id = nextId++
    const ok = !failOn.includes(siteId)
    events.unshift({ id, status: ok ? "deployed" : "failed", output: ok ? null : "boom", finished_at: "x" } as Event)
    calls.push(`${verb}:${siteId}`)
    return { event_id: id }
  }
  const client = {
    listSites: async () => sites.map((s) => ({ ...s })),
    listEvents: async () => events.map((e) => ({ ...e })),
    getEvent: async (id: number) => events.find((e) => e.id === id)!,
    disableSite: async (id: number) => {
      const s = sites.find((x) => x.id === id)!
      if (!failOn.includes(id)) s.disabled_at = "now"
      return push(id, "disable")
    },
    enableSite: async (id: number) => {
      const s = sites.find((x) => x.id === id)!
      if (!failOn.includes(id)) s.disabled_at = null
      return push(id, "enable")
    },
  } as unknown as SpinupWPClientLike
  return { client, calls }
}

const opts = () => ({ dir: mkdtempSync(join(tmpdir(), "offline-")), kuma: false, pollMs: 1 })

describe("takeServerOffline / bringServerOnline", () => {
  test("disables only live sites and records exactly those", async () => {
    const sites = [site(1, "a.com"), site(2, "b.com", true), site(3, "c.com")]
    const { client, calls } = fakeClient(sites)
    const o = opts()
    const res = await takeServerOffline(client, cfg, server, o)
    expect(res.disabled.sort()).toEqual(["a.com", "c.com"])
    expect(res.alreadyOffline).toEqual(["b.com"])
    expect(calls).toEqual(["disable:1", "disable:3"])
    expect(loadOfflineState(o.dir).servers["1"]!.sites.map((s) => s.id)).toEqual([1, 3])
  })

  test("online re-enables only what offline took down, then forgets the server", async () => {
    const sites = [site(1, "a.com"), site(2, "b.com", true)]
    const { client, calls } = fakeClient(sites)
    const o = opts()
    await takeServerOffline(client, cfg, server, o)
    const res = await bringServerOnline(client, cfg, 1, o)
    expect(res.enabled).toEqual(["a.com"])
    expect(calls).toEqual(["disable:1", "enable:1"])
    expect(sites[1]!.disabled_at).not.toBeNull() // disabled elsewhere: left alone
    expect(loadOfflineState(o.dir).servers["1"]).toBeUndefined()
  })

  test("a failed enable stays recorded so a re-run finishes the job", async () => {
    const sites = [site(1, "a.com"), site(2, "b.com")]
    const o = opts()
    await takeServerOffline(fakeClient(sites).client, cfg, server, o)
    const res = await bringServerOnline(fakeClient(sites, [2]).client, cfg, 1, o)
    expect(res.enabled).toEqual(["a.com"])
    expect(res.failed.map((f) => f.domain)).toEqual(["b.com"])
    expect(loadOfflineState(o.dir).servers["1"]!.sites.map((s) => s.id)).toEqual([2])
  })

  test("a site re-enabled by hand counts as already online", async () => {
    const sites = [site(1, "a.com")]
    const { client, calls } = fakeClient(sites)
    const o = opts()
    await takeServerOffline(client, cfg, server, o)
    sites[0]!.disabled_at = null
    const res = await bringServerOnline(client, cfg, 1, o)
    expect(res.alreadyOnline).toEqual(["a.com"])
    expect(calls).toEqual(["disable:1"])
  })

  test("online on a server nothing was recorded for does nothing", async () => {
    const { client, calls } = fakeClient([site(1, "a.com", true)])
    const res = await bringServerOnline(client, cfg, 1, opts())
    expect(res.nothingRecorded).toBe(true)
    expect(calls).toEqual([])
  })
})

describe("waitForEvents", () => {
  test("reports a never-finishing event as a timeout, not a failure", async () => {
    const client = {
      listEvents: async () => [{ id: 5, status: "queued", finished_at: null } as Event],
      getEvent: async () => ({ id: 5, status: "queued", finished_at: null }) as Event,
    } as unknown as SpinupWPClientLike
    const out = await waitForEvents(client, [5], { timeoutMs: 20, pollMs: 5 })
    expect(out.get(5)).toBe("timeout")
  })
})

describe("matchServer", () => {
  const servers = [server, { id: 2, name: "web10.example.com", ip_address: "203.0.113.11" } as Server]
  test("matches exact name, IP or id only", () => {
    expect(matchServer(servers, "WEB1.example.com").ok).toBe(true)
    expect(matchServer(servers, "203.0.113.11").ok && matchServer(servers, "203.0.113.11")).toMatchObject({ server: { id: 2 } })
    expect(matchServer(servers, "2").ok).toBe(true)
  })
  test("a partial name is refused, with suggestions", () => {
    const m = matchServer(servers, "web1")
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.suggestions).toEqual(["web1.example.com", "web10.example.com"])
  })
})

import { describe, expect, test } from "bun:test"
import { applyAttach, planAttach } from "./sentinelAttach.ts"
import type { KumaMonitor } from "./uptimeKuma.ts"

const m = (id: number, name: string, over: Partial<KumaMonitor> = {}): KumaMonitor => ({ id, name, type: "http", ...over })
const sites = ["a.example.com", "b.example.com", "c.example.com"]

describe("planAttach", () => {
  test("matches by the naming convention", () => {
    const p = planAttach([m(1, "a.example.com"), m(2, "a.example.com load", { type: "push" }), m(3, "a.example.com php-fatal"), m(4, "a.example.com front page"), m(5, "a.example.com cache-bypass"), m(6, "a.example.com redis")], sites, {})
    expect(p.exact.map((x) => x.field).sort()).toEqual(["bypassId", "fatalId", "fingerprintId", "healthId", "pushId", "redisId"])
    expect(p.unmonitored).toEqual(["b.example.com", "c.example.com"])
  })

  test("a site with extra domains counts once", () => {
    const p = planAttach([], ["a.example.com", "www.a.example.com"], {}, ["a.example.com"])
    expect(p.unmonitored).toEqual(["a.example.com"])
  })

  test("a hand-made monitor on a fleet host is only likely", () => {
    const p = planAttach([m(1, "Client homepage", { url: "https://www.b.example.com/" })], sites, {})
    expect(p.exact).toEqual([])
    expect(p.likely).toMatchObject([{ domain: "b.example.com", field: "healthId", monitorId: 1 }])
  })

  test("ignores strangers, and what's already attached", () => {
    const p = planAttach([m(1, "a.example.com"), m(9, "My router", { url: "https://192.0.2.1" })], sites, { "a.example.com": { healthId: 1 } })
    expect(p.already).toBe(1)
    expect(p.exact).toEqual([])
    expect(p.strangers).toEqual(["My router"])
  })
})

describe("applyAttach", () => {
  test("keeps the token Kuma already holds, and never overwrites", () => {
    const monitors = [m(2, "a.example.com load", { type: "push", pushToken: "live-token" }), m(1, "a.example.com")]
    const r = applyAttach({ "a.example.com": { healthId: 7 } }, [{ domain: "a.example.com", field: "pushId", monitorId: 2, name: "" }, { domain: "a.example.com", field: "healthId", monitorId: 1, name: "" }], monitors)
    expect(r["a.example.com"]).toEqual({ healthId: 7, pushId: 2, pushToken: "live-token" })
  })

  test("rebuilds a fingerprint's keyword", () => {
    const r = applyAttach({}, [{ domain: "a.example.com", field: "fingerprintId", monitorId: 4, name: "" }], [m(4, "x", { keyword: "home", interval: 600 })])
    expect(r["a.example.com"]?.fingerprint).toMatchObject({ keyword: "home", kind: "attached", interval: 600 })
  })
})

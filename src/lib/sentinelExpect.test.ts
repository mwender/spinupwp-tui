import { describe, expect, test } from "bun:test"
import { APT_COMMAND, cacheProbeCommand, loadShapeCommand, logCountCommand, readApt, runExpectation, validateExpectation, warmerCommand, type ExpectDeps, type Expectation } from "./sentinelExpect.ts"
import { classifySshCommand } from "./sshExecPolicy.ts"

const answering = (stdout: string | null, status: number | null = 200): ExpectDeps => ({ exec: async () => stdout, status: async () => status })

describe("every remote command", () => {
  test("gets past the ssh-exec policy", () => {
    const commands = [logCountCommand("SomeCrawler/1.1"), logCountCommand("/old_tax/"), loadShapeCommand(8), cacheProbeCommand("www.example.net", "/?gbraid=probe"), warmerCommand("~/files/cache-warm/logs/warm-*.log"), APT_COMMAND]
    for (const c of commands) expect([c, classifySshCommand(c).decision]).toEqual([c, "allow"])
  })
})

describe("validation", () => {
  const valid = (e: unknown) => validateExpectation(e as Expectation)

  test("accepts each type", () => {
    expect(valid({ id: "a-b", type: "log-count", domain: "example.com", match: "Bot/1.1", min: 10 })).toEqual([])
    expect(valid({ id: "a-b", type: "load-shape", domain: "example.com", threshold: 8 })).toEqual([])
    expect(valid({ id: "a-b", type: "cache-hit", domain: "example.com", host: "www.example.com", paths: ["/", "/?a=b"] })).toEqual([])
    expect(valid({ id: "a-b", type: "warmer", domain: "example.com", logGlob: "~/files/logs/warm-*.log" })).toEqual([])
    expect(valid({ id: "a-b", type: "status", url: "https://example.com/x", expect: 410 })).toEqual([])
  })

  test("keeps shell out of what reaches a remote command", () => {
    expect(valid({ id: "a-b", type: "log-count", domain: "example.com", match: 'x"; rm -rf ~; "' }).length).toBe(1)
    expect(valid({ id: "a-b", type: "log-count", domain: "example.com", match: "$(id)" }).length).toBe(1)
    expect(valid({ id: "a-b", type: "cache-hit", domain: "example.com", host: "h.example.com", paths: ["/?a=1&b=2"] }).length).toBe(1)
    expect(valid({ id: "a-b", type: "warmer", domain: "example.com", logGlob: "x; id" }).length).toBe(1)
    expect(valid({ id: "a-b", type: "cache-hit", domain: "example.com", host: "$(id)", paths: ["/"] }).length).toBe(1)
  })
})

describe("running a check", () => {
  const count: Expectation = { id: "c", type: "log-count", domain: "example.com", match: "Bot", min: 100, trend: true, label: "Bot" }

  test("log-count", async () => {
    expect(await runExpectation(count, answering("150\n"))).toMatchObject({ state: "ok", trend: "150" })
    expect(await runExpectation(count, answering("0\n"))).toMatchObject({ state: "flag", text: "LOW: 0 yesterday (expected ≥100)" })
  })

  test("a failed probe is unverified, never a pass or a flag", async () => {
    expect((await runExpectation(count, answering(null))).state).toBe("unverified")
    expect((await runExpectation(count, answering(""))).state).toBe("unverified")
    expect((await runExpectation({ id: "l", type: "load-shape", domain: "e.com", threshold: 8 }, answering(""))).state).toBe("unverified")
  })

  test("load-shape flags a latch, not a spike", async () => {
    const e: Expectation = { id: "l", type: "load-shape", domain: "e.com", threshold: 8 }
    expect(await runExpectation(e, answering("9.5 2 2\n"))).toMatchObject({ state: "ok", text: "load max 9.5, 2 over 8, longest 20 min" })
    expect((await runExpectation(e, answering("9.5 3 3\n"))).state).toBe("flag")
  })

  test("cache-hit", async () => {
    const e: Expectation = { id: "h", type: "cache-hit", domain: "e.com", host: "www.e.com", paths: ["/", "/a"] }
    expect((await runExpectation(e, answering("HIT\n"))).state).toBe("ok")
    expect(await runExpectation(e, answering("MISS\n"))).toMatchObject({ state: "flag" })
    expect((await runExpectation(e, answering(null))).state).toBe("unverified")
  })

  test("warmer", async () => {
    const e: Expectation = { id: "w", type: "warmer", domain: "e.com", logGlob: "~/w-*.log" }
    expect((await runExpectation(e, answering("12\n"))).state).toBe("ok")
    expect(await runExpectation(e, answering("0\n"))).toMatchObject({ state: "flag", text: "WARMER IDLE: 0 queued" })
  })

  test("status", async () => {
    const e: Expectation = { id: "s", type: "status", url: "https://e.com/x", expect: 410 }
    expect((await runExpectation(e, answering(null, 410))).state).toBe("ok")
    expect((await runExpectation(e, answering(null, 200))).state).toBe("flag")
    expect((await runExpectation(e, answering(null, null))).state).toBe("unverified")
  })
})

describe("readApt", () => {
  const now = 1_800_000_000
  test("healthy", () => expect(readApt(`${now - 3600} ${now} inactive 0`)).toEqual({ flag: null }))
  test("stale", () => expect(readApt(`${now - 10 * 86_400} ${now} inactive 0`)!.flag).toContain("STALE: last successful update 10d ago"))
  test("no stamp", () => expect(readApt(`none ${now} inactive 0`)!.flag).toContain("no successful update"))
  test("stuck", () => expect(readApt(`${now} ${now} activating ${now - 3 * 86_400}`)!.flag).toContain("STUCK: apt-daily running 3d"))
  test("unreadable", () => expect(readApt(null)).toBeNull())
})

import { describe, expect, test } from "bun:test"
import type { AppConfig } from "../config.ts"
import { chooseNotifications, pagerProblem, parsePushUrl, pingUrl, sendHeartbeat, stationMonitorPayload, tickHeartbeat } from "./heartbeat.ts"

const PUSH = "https://kuma.example.com/api/push/AbC123?status=up&msg=OK&ping="

describe("push URLs", () => {
  test("accepts Kuma's push URL with or without its query", () => {
    expect(parsePushUrl(PUSH)?.toString()).toBe("https://kuma.example.com/api/push/AbC123")
    expect(parsePushUrl("https://kuma.example.com/api/push/AbC123")).not.toBeNull()
    expect(parsePushUrl("https://kuma.example.com/dashboard/12")).toBeNull()
    expect(parsePushUrl("ftp://kuma.example.com/api/push/x")).toBeNull()
    expect(parsePushUrl("not a url")).toBeNull()
  })

  test("each ping sets status, msg and ping", () => {
    const u = new URL(pingUrl(PUSH, "down", "pager broken", 1234.6))
    expect(u.searchParams.get("status")).toBe("down")
    expect(u.searchParams.get("msg")).toBe("pager broken")
    expect(u.searchParams.get("ping")).toBe("1235")
  })
})

describe("what a tick reports", () => {
  test("up, with what ran and the first problem", () => {
    expect(tickHeartbeat(0, [], null)).toEqual({ status: "up", msg: "tick ok, nothing due" })
    expect(tickHeartbeat(2, ["git push failed"], null)).toEqual({ status: "up", msg: "tick ok, 2 jobs ran; 1 problem: git push failed" })
  })

  test("down when the pager is broken", () => {
    expect(tickHeartbeat(1, [], "Beacon's last page failed (HTTP 401)").status).toBe("down")
  })

  test("pagerProblem: no channel, or the last page failed", () => {
    const none = { beacon: null } as unknown as AppConfig
    const one = { beacon: { defaultChannel: "pager", channels: { pager: { type: "telegram", botToken: "t", chatId: "1" } } } } as unknown as AppConfig
    const entry = (ok: boolean) => ({ at: "", channel: "pager", ok, parts: 1, chars: 1, preview: "", ...(ok ? {} : { error: "HTTP 401" }) })
    expect(pagerProblem(none, null)).toMatch(/isn't set up/)
    expect(pagerProblem(one, null)).toBeNull()
    expect(pagerProblem(one, entry(true))).toBeNull()
    expect(pagerProblem(one, entry(false))).toMatch(/HTTP 401/)
  })
})

describe("sendHeartbeat against a fake Kuma", () => {
  test("ok, Kuma's refusal, and an unreachable host", async () => {
    const seen: URL[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url)
        seen.push(u)
        return Response.json(u.pathname.endsWith("/good") ? { ok: true } : { ok: false, msg: "Monitor not found or not active." })
      },
    })
    try {
      const base = `http://127.0.0.1:${server.port}/api/push`
      expect(await sendHeartbeat(`${base}/good`, "up", "tick ok", 10)).toEqual({ ok: true, status: "up", msg: "tick ok" })
      expect(seen[0]!.searchParams.get("status")).toBe("up")
      const bad = await sendHeartbeat(`${base}/gone`, "up", "tick ok")
      expect(bad.ok).toBe(false)
      expect(bad.error).toBe("Monitor not found or not active.")
    } finally {
      server.stop(true)
    }
    expect((await sendHeartbeat("http://127.0.0.1:1/api/push/x", "up", "m")).ok).toBe(false)
  })
})

describe("station monitor setup", () => {
  const n = (id: number, name: string, isDefault = false) => ({ id, name, active: true, isDefault })

  test("who it alerts", () => {
    expect(chooseNotifications([n(1, "Pager")]).chosen.map((x) => x.id)).toEqual([1])
    expect(chooseNotifications([n(1, "Email"), n(2, "Telegram", true)]).chosen.map((x) => x.id)).toEqual([2])
    expect(chooseNotifications([n(1, "Email"), n(2, "Telegram")]).needChoice).toMatch(/--notify/)
    expect(chooseNotifications([n(1, "Email"), n(2, "Telegram")], "telegram").chosen.map((x) => x.id)).toEqual([2])
    expect(chooseNotifications([n(1, "Email")], "2").needChoice).toMatch(/No active Kuma notification/)
    expect(chooseNotifications([]).needChoice).toMatch(/no active notifications/)
  })

  test("a push monitor that waits three ticks", () => {
    const p = stationMonitorPayload("SpinupTUI station: x", "tok")
    expect(p).toMatchObject({ type: "push", pushToken: "tok", interval: 900, maxretries: 0 })
  })
})

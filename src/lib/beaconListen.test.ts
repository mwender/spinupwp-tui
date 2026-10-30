import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleUpdate, listen, readListenerState, routesFrom, sendReply, storeButton, takeButton, type TgUpdate } from "./beaconListen.ts"
import type { BeaconReply } from "../modules/contract.ts"

const TOKEN = "123456789:AAEabcdefghijklmnopqrstuvwxyz0123456"
const OP = 4242
const channel = { type: "telegram" as const, botToken: TOKEN, chatId: String(OP) }
const NOW = new Date("2026-10-29T12:00:00Z")
const sec = (d: Date) => Math.floor(d.getTime() / 1000)

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "listen-"))
})

// Records every Telegram call; getUpdates answers from `rounds`, then aborts.
// An empty round waits a moment, like a real long-poll, so a loop that never
// stops can't starve the test's timers.
function fakeTelegram(rounds: TgUpdate[][] = [], onEmpty?: () => void) {
  const calls: { method: string; params: URLSearchParams }[] = []
  const impl = async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop()!
    calls.push({ method, params: init?.body as URLSearchParams })
    if (method === "getUpdates") {
      const next = rounds.shift()
      if (!next) {
        onEmpty?.()
        await Bun.sleep(5)
      }
      return new Response(JSON.stringify({ ok: true, result: next ?? [] }))
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }))
  }
  return { impl, calls, sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.params.get("text")!) }
}

const message = (id: number, text: string, from = OP, chat = OP, date = NOW): TgUpdate => ({
  update_id: id,
  message: { message_id: id, date: sec(date), chat: { id: chat, type: chat > 0 ? "private" : "group" }, from: { id: from }, text },
})

function routes(runs: string[] = []) {
  return routesFrom([
    {
      commands: [{ command: "jobs", describe: "list jobs", run: async (): Promise<BeaconReply> => ({ text: "the jobs", buttons: [[{ text: "Extend", action: "t.extend", payload: { id: "a" } }]] }) }],
      actions: [{ action: "t.extend", run: async (p) => (runs.push(p.id!), { text: `extended ${p.id}` }) }],
    },
  ])
}

describe("handleUpdate", () => {
  test("answers the operator's command, with buttons as one-use tokens", async () => {
    const tg = fakeTelegram()
    const h = await handleUpdate(message(1, "/jobs@station_bot"), { channel, routes: routes(), fetchImpl: tg.impl, now: () => NOW })
    expect(h).toEqual({ kind: "command", command: "jobs", replied: null })
    expect(tg.sent()).toEqual(["the jobs"])
    const markup = JSON.parse(tg.calls[0]!.params.get("reply_markup")!)
    const data: string = markup.inline_keyboard[0][0].callback_data
    expect(data).toMatch(/^b:[\w-]{8}$/)
    expect(takeButton(data.slice(2))).toMatchObject({ action: "t.extend", payload: { id: "a" } })
    expect(takeButton(data.slice(2))).toBeNull()
  })

  test("ignores strangers, groups and stale commands without replying", async () => {
    const tg = fakeTelegram()
    const ctx = { channel, routes: routes(), fetchImpl: tg.impl, now: () => NOW }
    expect((await handleUpdate(message(1, "/jobs", 999, 999), ctx)).kind).toBe("ignored")
    expect((await handleUpdate(message(2, "/jobs", OP, -100), ctx)).kind).toBe("ignored")
    // The operator, but in someone else's chat with the bot? Not possible in a
    // private chat, but a forged pairing is still refused.
    expect((await handleUpdate(message(3, "/jobs", 999, OP), ctx)).kind).toBe("ignored")
    expect((await handleUpdate(message(4, "/jobs", OP, OP, new Date(NOW.getTime() - 11 * 60_000)), ctx)).kind).toBe("ignored")
    expect(tg.calls).toEqual([])
  })

  test("unknown commands and plain text get the help list", async () => {
    const tg = fakeTelegram()
    const ctx = { channel, routes: routes(), fetchImpl: tg.impl, now: () => NOW }
    await handleUpdate(message(1, "/nope"), ctx)
    await handleUpdate(message(2, "hello"), ctx)
    expect(tg.sent()).toEqual(["This station answers:\n/jobs — list jobs", "This station answers:\n/jobs — list jobs"])
  })

  test("a tap runs its action once; a second tap is told the button is used", async () => {
    const runs: string[] = []
    const tg = fakeTelegram()
    const ctx = { channel, routes: routes(runs), fetchImpl: tg.impl, now: () => NOW }
    const token = storeButton("t.extend", { id: "nightly" })
    const tap = (id: number, from = OP): TgUpdate => ({
      update_id: id,
      callback_query: { id: `q${id}`, from: { id: from }, message: { message_id: 9, date: sec(NOW), chat: { id: OP, type: "private" } }, data: `b:${token}` },
    })
    expect((await handleUpdate(tap(1, 999), ctx)).kind).toBe("ignored")
    expect(await handleUpdate(tap(2), ctx)).toEqual({ kind: "tap", action: "t.extend", replied: null })
    expect(await handleUpdate(tap(3), ctx)).toEqual({ kind: "tap", action: null, replied: null })
    expect(runs).toEqual(["nightly"])
    expect(tg.sent()).toEqual(["extended nightly"])
    const answers = tg.calls.filter((c) => c.method === "answerCallbackQuery")
    expect(answers.map((a) => a.params.get("text"))).toEqual([null, "This button has already been used or has expired."])
  })

  test("an action that throws is reported, not fatal", async () => {
    const tg = fakeTelegram()
    const r = routesFrom([{ commands: [{ command: "boom", describe: "x", run: async () => Promise.reject(new Error("disk full")) }] }])
    await handleUpdate(message(1, "/boom"), { channel, routes: r, fetchImpl: tg.impl, now: () => NOW })
    expect(tg.sent()).toEqual(["/boom failed: disk full"])
  })
})

describe("sendReply", () => {
  test("sends HTML, and falls back to plain text if Telegram refuses it", async () => {
    const calls: URLSearchParams[] = []
    const impl = async (_url: string, init?: RequestInit) => {
      const p = init?.body as URLSearchParams
      calls.push(p)
      if (p.get("parse_mode")) return new Response(JSON.stringify({ ok: false, description: "can't parse entities" }), { status: 400 })
      return new Response(JSON.stringify({ ok: true, result: {} }))
    }
    expect(await sendReply({ channel, routes: routes(), fetchImpl: impl }, { text: "<b>a &amp; b</b>", html: true })).toBeNull()
    expect(calls[0]!.get("parse_mode")).toBe("HTML")
    expect(calls[1]!.get("parse_mode")).toBeNull()
    expect(calls[1]!.get("text")).toBe("a & b")
  })
})

describe("listen", () => {
  test("saves the offset before acting, so a restart doesn't repeat an update", async () => {
    const ctrl = new AbortController()
    const tg = fakeTelegram([[message(41, "/jobs", OP, OP, new Date())]], () => ctrl.abort())
    const r = await listen({ channel, channelName: "pager", routes: routes(), fetchImpl: tg.impl, signal: ctrl.signal, sleep: async () => {} })
    expect(r).toEqual({ ok: true, reason: "stopped" })
    expect(readListenerState()).toMatchObject({ channel: "pager", offset: 42 })
    expect(tg.calls.find((c) => c.method === "getUpdates" && c.params.get("offset") === "42")).toBeTruthy()

    // A restart resumes from the saved offset.
    const ctrl2 = new AbortController()
    const tg2 = fakeTelegram([], () => ctrl2.abort())
    await listen({ channel, channelName: "pager", routes: routes(), fetchImpl: tg2.impl, signal: ctrl2.signal, sleep: async () => {} })
    expect(tg2.calls[0]!.params.get("offset")).toBe("42")
  })

  test("exits after an upgrade so launchd restarts the new code", async () => {
    let v = "1.3.0-alpha.4"
    const tg = fakeTelegram([[]], () => (v = "1.3.0-alpha.5"))
    const r = await listen({ channel, channelName: "pager", routes: routes(), fetchImpl: tg.impl, version: () => v, sleep: async () => {} })
    expect(r).toEqual({ ok: true, reason: "upgraded" })
  })

  test("refuses a group channel, and a second listener", async () => {
    expect(await listen({ channel: { ...channel, chatId: "-1001" }, channelName: "ops", routes: routes() })).toMatchObject({ ok: false, reason: "bad_channel" })
    const ctrl = new AbortController()
    const tg = fakeTelegram([], () => {})
    const first = listen({ channel, channelName: "pager", routes: routes(), fetchImpl: tg.impl, signal: ctrl.signal, sleep: async () => {} })
    await Bun.sleep(10)
    expect(await listen({ channel, channelName: "pager", routes: routes() })).toMatchObject({ ok: false, reason: "locked" })
    ctrl.abort()
    await first
  })
})

import { describe, expect, test } from "bun:test"
import { discoverChat, looksLikeBotToken } from "./beaconSetup.ts"

const TOKEN = "123456789:AAEabcdefghijklmnopqrstuvwxyz0123456"

function fakeUpdates(rounds: Array<{ status?: number; body: unknown }>) {
  const calls: URLSearchParams[] = []
  const impl = async (_url: string, init?: RequestInit) => {
    calls.push(init?.body as URLSearchParams)
    const next = rounds.shift() ?? { body: { ok: true, result: [] } }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
  }
  return { impl, calls }
}

const chat = (id: number, extra: Record<string, unknown> = {}) => ({ id, type: "private", first_name: "Jane", ...extra })

describe("discoverChat", () => {
  test("skips messages already waiting and returns the next chat", async () => {
    const f = fakeUpdates([
      { body: { ok: true, result: [{ update_id: 7, message: { chat: chat(111) } }] } }, // stale
      { body: { ok: true, result: [] } }, // a quiet long-poll round
      { body: { ok: true, result: [{ update_id: 8, message: { chat: chat(222, { username: "jane" }) } }] } },
    ])
    const r = await discoverChat(TOKEN, { fetchImpl: f.impl, timeoutMs: 60_000 })
    expect(r).toEqual({ ok: true, chat: { chatId: "222", kind: "private", label: "Jane (@jane)" } })
    // The first listening round starts after the stale update.
    expect(f.calls[1]!.get("offset")).toBe("8")
    // The found update is acknowledged.
    expect(f.calls[3]!.get("offset")).toBe("9")
  })

  test("a group chat is labelled by its title", async () => {
    const f = fakeUpdates([
      { body: { ok: true, result: [] } },
      { body: { ok: true, result: [{ update_id: 1, my_chat_member: { chat: { id: -100, type: "supergroup", title: "Ops alerts" } } }] } },
    ])
    const r = await discoverChat(TOKEN, { fetchImpl: f.impl, timeoutMs: 60_000 })
    expect(r.ok && r.chat).toEqual({ chatId: "-100", kind: "supergroup", label: "Ops alerts" })
  })

  test("a webhook conflict is explained", async () => {
    const f = fakeUpdates([{ status: 409, body: { ok: false, description: "Conflict: can't use getUpdates method while webhook is active" } }])
    const r = await discoverChat(TOKEN, { fetchImpl: f.impl })
    expect(!r.ok && r.reason).toBe("conflict")
    expect(!r.ok && r.message).toContain("webhook")
  })

  test("an aborted signal cancels", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const impl = async (_u: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return new Response("{}")
    }
    const r = await discoverChat(TOKEN, { fetchImpl: impl, signal: ctrl.signal })
    expect(!r.ok && r.reason).toBe("cancelled")
  })
})

test("looksLikeBotToken", () => {
  expect(looksLikeBotToken(TOKEN)).toBe(true)
  expect(looksLikeBotToken("not-a-token")).toBe(false)
  expect(looksLikeBotToken("123:short")).toBe(false)
})

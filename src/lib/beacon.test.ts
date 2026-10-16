import { describe, expect, test } from "bun:test"
import { beaconSend, MAX_PARTS, maskToken, parseEnvFile, resolveBeacon, splitMessage, TELEGRAM_LIMIT, type ResolvedBeacon } from "./beacon.ts"

const pager: ResolvedBeacon = {
  channels: [{ name: "pager", channel: { type: "telegram", botToken: "123:SECRET", chatId: "-1001" }, env: false }],
  defaultChannel: "pager",
}

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; params: URLSearchParams }> = []
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, params: init?.body as URLSearchParams })
    const next = responses.shift() ?? { status: 200, body: { ok: true, result: {} } }
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.body), { status: next.status })
  }
  return { impl, calls }
}

const noWait = async () => {}

describe("resolveBeacon", () => {
  test("a lone stored channel is the default", () => {
    const r = resolveBeacon({ channels: { pager: { type: "telegram", botToken: "1:a", chatId: "2" } } }, {})
    expect(r.defaultChannel).toBe("pager")
  })

  test("env channel is added and becomes default unless one is chosen", () => {
    const env = { SPINUPTUI_BEACON_TELEGRAM_TOKEN: "9:z", SPINUPTUI_BEACON_TELEGRAM_CHAT_ID: "5" }
    const stored = { channels: { pager: { type: "telegram" as const, botToken: "1:a", chatId: "2" } } }
    expect(resolveBeacon(stored, env).defaultChannel).toBe("env")
    expect(resolveBeacon({ ...stored, defaultChannel: "pager" }, env).defaultChannel).toBe("pager")
    expect(resolveBeacon(stored, env).channels.find((c) => c.name === "env")?.env).toBe(true)
  })

  test("two stored channels and no choice means no default", () => {
    const ch = { type: "telegram" as const, botToken: "1:a", chatId: "2" }
    expect(resolveBeacon({ channels: { a: ch, b: ch } }, {}).defaultChannel).toBeNull()
  })
})

describe("splitMessage", () => {
  test("short text is untouched", () => {
    expect(splitMessage("hello")).toEqual(["hello"])
  })

  test("long text splits on lines, numbered, each under the limit", () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n")
    const parts = splitMessage(text)
    expect(parts.length).toBeGreaterThan(1)
    parts.forEach((p, i) => {
      expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT)
      expect(p.startsWith(`(${i + 1}/${parts.length}) `)).toBe(true)
    })
    // Nothing lost or reordered.
    expect(parts.map((p) => p.replace(/^\(\d+\/\d+\) /, "")).join("\n")).toBe(text)
  })

  test("a single huge line is hard-split", () => {
    const parts = splitMessage("y".repeat(9000))
    expect(parts.length).toBe(3)
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT))
  })

  test("beyond the part cap the last part is truncated with a marker", () => {
    const parts = splitMessage("z".repeat(4000 * 8))
    expect(parts.length).toBe(MAX_PARTS)
    expect(parts[MAX_PARTS - 1]).toContain("[truncated:")
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(TELEGRAM_LIMIT))
  })
})

describe("parseEnvFile", () => {
  test("handles export, quotes and comments", () => {
    const env = parseEnvFile(`# creds\nexport TELEGRAM_BOT_TOKEN="1:abc"\nTELEGRAM_CHAT_ID='-100' \nOTHER=x # note\n`)
    expect(env).toEqual({ TELEGRAM_BOT_TOKEN: "1:abc", TELEGRAM_CHAT_ID: "-100", OTHER: "x" })
  })
})

test("maskToken keeps only the bot id", () => {
  expect(maskToken("123456:AAE-secret")).toBe("123456:…")
})

describe("beaconSend", () => {
  test("sends plain text with previews off", async () => {
    const f = fakeFetch([])
    const r = await beaconSend(pager, "site down", { fetchImpl: f.impl, wait: noWait, log: false })
    expect(r).toEqual({ ok: true, channel: "pager", parts: 1, chars: 9 })
    expect(f.calls[0]!.params.get("disable_web_page_preview")).toBe("true")
    expect(f.calls[0]!.params.has("parse_mode")).toBe(false)
    expect(f.calls[0]!.params.has("disable_notification")).toBe(false)
  })

  test("--silent sets disable_notification", async () => {
    const f = fakeFetch([])
    await beaconSend(pager, "digest", { silent: true, fetchImpl: f.impl, wait: noWait, log: false })
    expect(f.calls[0]!.params.get("disable_notification")).toBe("true")
  })

  test("retries a 429 and a network error, then succeeds", async () => {
    const f = fakeFetch([{ status: 429, body: { ok: false, parameters: { retry_after: 1 } } }, new Error("socket hang up")])
    const r = await beaconSend(pager, "x", { fetchImpl: f.impl, wait: noWait, log: false })
    expect(r.ok).toBe(true)
    expect(f.calls.length).toBe(3)
  })

  test("a 400 is not retried and is a delivery failure", async () => {
    const f = fakeFetch([{ status: 400, body: { ok: false, description: "Bad Request: chat not found" } }])
    const r = await beaconSend(pager, "x", { fetchImpl: f.impl, wait: noWait, log: false })
    expect(f.calls.length).toBe(1)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("delivery_failed")
      expect(r.message).toContain("chat not found")
    }
  })

  test("network errors never leak the token", async () => {
    const f = fakeFetch([new Error("fail https://api.telegram.org/bot123:SECRET/sendMessage"), new Error("x"), new Error("x")])
    const r = await beaconSend(pager, "x", { fetchImpl: f.impl, wait: noWait, log: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).not.toContain("SECRET")
  })

  test("not configured and empty messages attempt nothing", async () => {
    const f = fakeFetch([])
    const none = await beaconSend({ channels: [], defaultChannel: null }, "x", { fetchImpl: f.impl, log: false })
    const empty = await beaconSend(pager, "   ", { fetchImpl: f.impl, log: false })
    expect(!none.ok && none.reason).toBe("not_configured")
    expect(!empty.ok && empty.reason).toBe("empty_message")
    expect(f.calls.length).toBe(0)
  })

  test("a multi-part send stops at the first failed part", async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true } }, { status: 403, body: { ok: false, description: "Forbidden" } }])
    const r = await beaconSend(pager, "q".repeat(9000), { fetchImpl: f.impl, wait: noWait, log: false })
    expect(!r.ok && r.partsSent).toBe(1)
    expect(f.calls.length).toBe(2)
  })
})

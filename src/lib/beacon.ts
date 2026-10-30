// Beacon: one notification layer for SpinupTUI and its modules
// (docs/2026-10-16_beacon-and-module-contract-spec.md). This round is the
// operator channel only — a Telegram pager.
//
// Messages go out as plain text (never parse_mode: an underscore in a domain
// must not break a page), with link previews off. Anything over Telegram's
// 4096-character limit is split on line boundaries instead of being dropped.
// Every send is appended to the module's send.log, which is how a caller's
// cutover is verified. Nothing here writes config.json.

import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import type { AppConfig, BeaconChannel, BeaconStored } from "../config.ts"
import { moduleStateDir } from "../modules/contract.ts"

export const TELEGRAM_LIMIT = 4096
// Room left under the limit for the "(1/3) " prefix.
const PART_BUDGET = 4000
export const MAX_PARTS = 5
const ATTEMPTS = 3
const TIMEOUT_MS = 15_000
const LOG_MAX_BYTES = 1_000_000
const TELEGRAM_API = "https://api.telegram.org"

export interface ResolvedChannel {
  name: string
  channel: BeaconChannel
  env: boolean // from SPINUPTUI_BEACON_* — read-only
}

export interface ResolvedBeacon {
  channels: ResolvedChannel[]
  defaultChannel: string | null
}

// Stored channels plus the read-only env channel. The env channel is the default
// only when no stored channel has been made the default; a lone channel is the
// default automatically.
export function resolveBeacon(stored: BeaconStored | null, env: Record<string, string | undefined> = process.env): ResolvedBeacon {
  const channels: ResolvedChannel[] = Object.entries(stored?.channels ?? {}).map(([name, channel]) => ({ name, channel, env: false }))
  const token = env.SPINUPTUI_BEACON_TELEGRAM_TOKEN?.trim()
  const chatId = env.SPINUPTUI_BEACON_TELEGRAM_CHAT_ID?.trim()
  if (token && chatId) channels.push({ name: "env", channel: { type: "telegram", botToken: token, chatId }, env: true })
  const want = stored?.defaultChannel
  let defaultChannel: string | null = null
  if (want && channels.some((c) => c.name === want)) defaultChannel = want
  else if (channels.some((c) => c.name === "env")) defaultChannel = "env"
  else if (channels.length === 1) defaultChannel = channels[0]!.name
  return { channels, defaultChannel }
}

export function beaconFromConfig(cfg: AppConfig): ResolvedBeacon {
  return resolveBeacon(cfg.beacon)
}

// "123456789:AAE…" → "123456789:…" — the bot id identifies it, the rest is secret.
export function maskToken(token: string): string {
  const i = token.indexOf(":")
  return i > 0 ? `${token.slice(0, i)}:…` : "…"
}

export function maskChatId(chatId: string): string {
  return chatId.length <= 4 ? "…" : `…${chatId.slice(-4)}`
}

// Split text into parts that fit Telegram's limit, on line boundaries where
// possible, numbering them when there's more than one. Beyond MAX_PARTS the last
// part is cut short with a marker saying how much was left out.
export function splitMessage(text: string, budget = PART_BUDGET, maxParts = MAX_PARTS): string[] {
  if (text.length <= TELEGRAM_LIMIT) return [text]
  const chunks: string[] = []
  let current = ""
  const push = () => {
    if (current) chunks.push(current)
    current = ""
  }
  for (const line of text.split("\n")) {
    let rest = line
    // A single line longer than the budget is hard-split.
    while (rest.length > budget) {
      push()
      chunks.push(rest.slice(0, budget))
      rest = rest.slice(budget)
    }
    const next = current ? `${current}\n${rest}` : rest
    if (next.length > budget) {
      push()
      current = rest
    } else {
      current = next
    }
  }
  push()
  let parts = chunks
  if (parts.length > maxParts) {
    const dropped = parts.slice(maxParts).reduce((n, p) => n + p.length + 1, 0)
    const marker = `\n… [truncated: ${dropped} more characters]`
    parts = parts.slice(0, maxParts)
    const last = parts[maxParts - 1]!
    parts[maxParts - 1] = last.slice(0, budget - marker.length) + marker
  }
  return parts.map((p, i) => `(${i + 1}/${parts.length}) ${p}`)
}

// For replies sent as Telegram HTML, where only these three are special. Pages
// stay plain text, so a markup mistake can never cost an alert.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function htmlToPlain(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

// Parse a KEY=VALUE env file the way the existing shell senders write them:
// `export ` prefixes, quotes and # comments allowed.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2]!.trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, "")
    out[m[1]!] = v
  }
  return out
}

// ---- Telegram transport -------------------------------------------------------

export interface TelegramCallResult {
  ok: boolean
  status: number // HTTP status, 0 for a network error/timeout
  error?: string
  retryAfter?: number
  result?: unknown
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export async function telegramCall(
  token: string,
  method: string,
  params: Record<string, string>,
  fetchImpl: Fetch = fetch,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TelegramCallResult> {
  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
    const res = await fetchImpl(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      body: new URLSearchParams(params),
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; description?: string; parameters?: { retry_after?: number }; result?: unknown } | null
    if (res.ok && body?.ok) return { ok: true, status: res.status, result: body.result }
    return {
      ok: false,
      status: res.status,
      error: body?.description || `HTTP ${res.status}`,
      retryAfter: body?.parameters?.retry_after,
    }
  } catch (err) {
    // Never echo the URL: it carries the token.
    const e = err as Error
    if (opts.signal?.aborted) return { ok: false, status: 0, error: "cancelled" }
    return { ok: false, status: 0, error: e.name === "TimeoutError" ? "timed out" : e.message.replaceAll(token, "…") }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Three attempts: honor retry_after on 429, back off on 5xx/network errors, and
// give up at once on any other 4xx (a bad token or chat id won't fix itself).
async function telegramWithRetry(
  token: string,
  method: string,
  params: Record<string, string>,
  fetchImpl: Fetch,
  wait: (ms: number) => Promise<unknown>,
): Promise<TelegramCallResult> {
  let last: TelegramCallResult = { ok: false, status: 0, error: "not attempted" }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await telegramCall(token, method, params, fetchImpl)
    if (last.ok) return last
    const retryable = last.status === 0 || last.status === 429 || last.status >= 500
    if (!retryable || attempt === ATTEMPTS) break
    await wait(last.status === 429 ? Math.min(last.retryAfter ?? 5, 30) * 1000 : 2000 * attempt)
  }
  return last
}

export interface TelegramIdentity {
  ok: boolean
  username?: string
  error?: string
}

export async function telegramGetMe(token: string, fetchImpl: Fetch = fetch): Promise<TelegramIdentity> {
  const r = await telegramCall(token, "getMe", {}, fetchImpl)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, username: (r.result as { username?: string } | undefined)?.username }
}

// ---- send ---------------------------------------------------------------------

export type SendResult =
  | { ok: true; channel: string; parts: number; chars: number }
  | {
      ok: false
      // not_configured / unknown_channel / empty_message: nothing was attempted
      // (exit 1). delivery_failed: Beacon tried and Telegram refused or was
      // unreachable (exit 2) — callers must not retry through another path.
      reason: "not_configured" | "unknown_channel" | "empty_message" | "delivery_failed"
      message: string
      remedy?: string
      channel?: string
      partsSent?: number
      parts?: number
    }

export interface SendOptions {
  to?: string | null
  silent?: boolean
  fetchImpl?: Fetch
  wait?: (ms: number) => Promise<unknown>
  log?: boolean
}

export function pickChannel(beacon: ResolvedBeacon, to: string | null | undefined): ResolvedChannel | Extract<SendResult, { ok: false }> {
  if (beacon.channels.length === 0) {
    return {
      ok: false,
      reason: "not_configured",
      message: "Beacon has no channels configured.",
      remedy: "Add one with `spinuptui beacon add telegram <name> --env-file <path>`.",
    }
  }
  const name = to || beacon.defaultChannel
  if (!name) {
    return {
      ok: false,
      reason: "unknown_channel",
      message: `No default channel; pick one with --to (${beacon.channels.map((c) => c.name).join(", ")}).`,
      remedy: "Or make one the default with `spinuptui beacon add … --default`.",
    }
  }
  const found = beacon.channels.find((c) => c.name === name)
  if (!found) {
    return {
      ok: false,
      reason: "unknown_channel",
      message: `No Beacon channel named "${name}" (have: ${beacon.channels.map((c) => c.name).join(", ")}).`,
    }
  }
  return found
}

export async function beaconSend(beacon: ResolvedBeacon, text: string, opts: SendOptions = {}): Promise<SendResult> {
  if (!text.trim()) return { ok: false, reason: "empty_message", message: "Nothing to send: the message is empty." }
  const picked = pickChannel(beacon, opts.to)
  if ("ok" in picked) return picked
  const { name, channel } = picked
  const parts = splitMessage(text)
  const fetchImpl = opts.fetchImpl ?? fetch
  const wait = opts.wait ?? sleep
  let sent = 0
  let failure: string | undefined
  for (const part of parts) {
    const r = await telegramWithRetry(
      channel.botToken,
      "sendMessage",
      {
        chat_id: channel.chatId,
        text: part,
        disable_web_page_preview: "true",
        ...(opts.silent ? { disable_notification: "true" } : {}),
      },
      fetchImpl,
      wait,
    )
    if (!r.ok) {
      failure = r.error
      break
    }
    sent++
  }
  const result: SendResult =
    failure === undefined
      ? { ok: true, channel: name, parts: parts.length, chars: text.length }
      : {
          ok: false,
          reason: "delivery_failed",
          message: `Telegram refused or was unreachable: ${failure}`,
          channel: name,
          partsSent: sent,
          parts: parts.length,
        }
  if (opts.log !== false) await appendSendLog(name, text, result)
  return result
}

// ---- send log -----------------------------------------------------------------

export function sendLogPath(): string {
  return join(moduleStateDir("beacon"), "send.log")
}

export interface SendLogEntry {
  at: string
  channel: string
  ok: boolean
  parts: number
  chars: number
  error?: string
  preview: string
}

async function appendSendLog(channel: string, text: string, result: SendResult): Promise<void> {
  const entry: SendLogEntry = {
    at: new Date().toISOString(),
    channel,
    ok: result.ok,
    parts: result.ok ? result.parts : (result.parts ?? 0),
    chars: text.length,
    ...(result.ok ? {} : { error: result.message }),
    preview: text.replace(/\s+/g, " ").trim().slice(0, 80),
  }
  try {
    const dir = moduleStateDir("beacon")
    await mkdir(dir, { recursive: true })
    const path = sendLogPath()
    const size = await stat(path).then((s) => s.size).catch(() => 0)
    if (size > LOG_MAX_BYTES) await rename(path, `${path}.1`)
    await appendFile(path, JSON.stringify(entry) + "\n", { mode: 0o600 })
  } catch {
    // Logging must never turn a delivered page into a failure.
  }
}

export function lastSendLogEntry(): SendLogEntry | null {
  try {
    const path = sendLogPath()
    if (!existsSync(path)) return null
    const lines = readFileSync(path, "utf8").trimEnd().split("\n")
    return JSON.parse(lines[lines.length - 1]!) as SendLogEntry
  } catch {
    return null
  }
}

export function testMessage(): string {
  return `Beacon test from ${hostname()} at ${new Date().toLocaleString()}. If you can read this, SpinupTUI can page you here.`
}

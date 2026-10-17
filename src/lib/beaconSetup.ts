// Guided Beacon setup, shared by `spinuptui beacon setup` and the Modules
// screen: check a bot token, find the chat to page by waiting for the user to
// message the bot, send a test, save.
//
// Creating the bot itself can't be automated — Telegram only issues bots through
// a chat with @BotFather — so that step is instructions. Finding the chat id is
// the part people get stuck on, and it can be: once the user messages the bot,
// Telegram's getUpdates hands us the chat. Stale updates (anything already
// waiting when setup starts) are skipped so an old conversation can't be picked
// by mistake. Reading updates acknowledges them on Telegram's side; Beacon never
// uses updates for anything else, so nothing is lost.

import { loadConfig, saveConfig, type BeaconStored, type BeaconTelegramChannel } from "../config.ts"
import { beaconSend, telegramCall, telegramGetMe, type Fetch, type TelegramIdentity } from "./beacon.ts"

export const BOTFATHER_URL = "https://t.me/BotFather"
export const BOTFATHER_STEPS = [
  "Open @BotFather in Telegram (t.me/BotFather) and send /newbot.",
  "Pick a display name, then a username ending in “bot”.",
  "BotFather replies with a token like 123456789:AAE… — copy it.",
]

// A loose shape check so a mis-paste fails fast with a clear message instead of
// a round trip to Telegram.
export function looksLikeBotToken(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim())
}

export async function verifyBotToken(token: string, fetchImpl?: Fetch): Promise<TelegramIdentity> {
  if (!looksLikeBotToken(token)) return { ok: false, error: "That doesn't look like a bot token (expected digits, a colon, then a long code)." }
  return telegramGetMe(token.trim(), fetchImpl)
}

export function botLink(username: string): string {
  return `https://t.me/${username}`
}

export interface FoundChat {
  chatId: string
  kind: "private" | "group" | "supergroup" | "channel"
  label: string // "Jane Doe (@jane)" / "Ops alerts"
}

export type DiscoverResult = { ok: true; chat: FoundChat } | { ok: false; reason: "timeout" | "cancelled" | "conflict" | "error"; message: string }

interface TgChat {
  id: number
  type: FoundChat["kind"]
  title?: string
  first_name?: string
  last_name?: string
  username?: string
}
interface TgUpdate {
  update_id: number
  message?: { chat: TgChat }
  channel_post?: { chat: TgChat }
  my_chat_member?: { chat: TgChat }
}

function describeChat(c: TgChat): FoundChat {
  const name = c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || String(c.id)
  return { chatId: String(c.id), kind: c.type, label: c.username ? `${name} (@${c.username})` : name }
}

function conflictMessage(error: string | undefined): string {
  return /webhook/i.test(error ?? "")
    ? "This bot has a webhook set, so Telegram won't hand its messages to Beacon. Use a bot made just for alerts, or remove the webhook."
    : "Something else is reading this bot's messages right now. Stop it, or use a bot made just for alerts."
}

// Wait for the next message to the bot (or the bot being added to a group or
// channel) and return that chat. Long-polls in 25-second rounds until
// `timeoutMs` or the signal aborts.
export async function discoverChat(
  token: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: Fetch } = {},
): Promise<DiscoverResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
  const call = (params: Record<string, string>, timeoutMs: number) =>
    telegramCall(token, "getUpdates", params, opts.fetchImpl, { timeoutMs, signal: opts.signal })

  // Skip whatever is already queued: only a message sent from now on counts.
  const first = await call({ timeout: "0" }, 15_000)
  if (!first.ok) {
    if (first.error === "cancelled") return { ok: false, reason: "cancelled", message: "Cancelled." }
    if (first.status === 409) return { ok: false, reason: "conflict", message: conflictMessage(first.error) }
    return { ok: false, reason: "error", message: `Couldn't read the bot's messages: ${first.error}` }
  }
  const stale = (first.result as TgUpdate[] | undefined) ?? []
  let offset = stale.length ? Math.max(...stale.map((u) => u.update_id)) + 1 : 0

  while (Date.now() < deadline) {
    const wait = Math.max(1, Math.min(25, Math.floor((deadline - Date.now()) / 1000)))
    const r = await call({ offset: String(offset), timeout: String(wait), allowed_updates: JSON.stringify(["message", "channel_post", "my_chat_member"]) }, (wait + 10) * 1000)
    if (!r.ok) {
      if (r.error === "cancelled") return { ok: false, reason: "cancelled", message: "Cancelled." }
      if (r.status === 409) return { ok: false, reason: "conflict", message: conflictMessage(r.error) }
      // A dropped long-poll is routine; pause and keep listening.
      await new Promise((res) => setTimeout(res, 2000))
      continue
    }
    for (const u of (r.result as TgUpdate[] | undefined) ?? []) {
      offset = Math.max(offset, u.update_id + 1)
      const chat = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat
      if (chat) {
        // Acknowledge it so a re-run doesn't see the same message as stale-but-new.
        await call({ offset: String(offset), timeout: "0" }, 15_000)
        return { ok: true, chat: describeChat(chat) }
      }
    }
  }
  return { ok: false, reason: "timeout", message: "No message reached the bot in time." }
}

export function channelExists(name: string): boolean {
  return Boolean(loadConfig().beacon?.channels?.[name])
}

// The name a guided setup configures: the stored default if there is one (so
// re-running setup repairs the pager rather than adding a second one), else "pager".
export function setupChannelName(): string {
  const stored = loadConfig().beacon
  const def = stored?.defaultChannel
  return def && stored?.channels?.[def] ? def : "pager"
}

export async function saveBeaconChannel(name: string, channel: BeaconTelegramChannel, makeDefault: boolean): Promise<{ isDefault: boolean }> {
  const stored: BeaconStored = loadConfig().beacon ?? {}
  const channels = { ...(stored.channels ?? {}), [name]: channel }
  const isDefault = makeDefault || !stored.defaultChannel || stored.defaultChannel === name
  await saveConfig({ beacon: { ...stored, channels, ...(isDefault ? { defaultChannel: name } : {}) } })
  return { isDefault }
}

// Send the "connected" message on a channel that isn't saved yet. Credentials
// that can't deliver are never stored, so callers save only after this succeeds.
export async function sendConnectedMessage(name: string, channel: BeaconTelegramChannel, fetchImpl?: Fetch) {
  return beaconSend({ channels: [{ name, channel, env: false }], defaultChannel: name }, `Beacon connected: channel "${name}" will page this chat.`, {
    log: false,
    fetchImpl,
  })
}

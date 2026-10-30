// Beacon's listener: the return half of the operator channel
// (docs/2026-10-15_ideas.md, "Two-way Beacon").
//
// One resident process long-polls Telegram for messages and button taps to the
// pager bot. Beacon owns the conversation, modules own what it means:
//
// - Identity: only the operator counts. The channel must be a private chat, and
//   an update is acted on only when both its chat and its sender are that chat's
//   id. Anything else is logged and ignored, without a reply, so a stranger who
//   finds the bot learns nothing.
// - Handled once: the next offset is saved before an update is acted on, so a
//   crash mid-action never repeats it (the operator can tap again; a repeat
//   could extend a job twice). Buttons carry a one-use token, not their payload.
// - Routing: a /command goes to the module that declared it, a tap to the
//   module that declared its action. Beacon has no module-specific logic.
//
// It long-polls 50 seconds at a time (about one request a minute when idle) and
// exits after an upgrade so its LaunchAgent restarts it on the new code.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import type { BeaconChannel } from "../config.ts"
import { moduleStateDir, type BeaconActionDecl, type BeaconButton, type BeaconCommandDecl, type BeaconReply, type ModuleDefinition } from "../modules/contract.ts"
import { htmlToPlain, splitMessage, telegramCall, type Fetch } from "./beacon.ts"
import { tryLock, type HeldLock } from "./flock.ts"

export const POLL_SECONDS = 50
// A /command older than this when it arrives (sent while the listener was down)
// is dropped rather than answered: the operator has likely moved on.
export const STALE_COMMAND_MS = 10 * 60_000
const BUTTON_TTL_MS = 30 * 24 * 60 * 60_000
const LOG_MAX_BYTES = 1_000_000

export const listenerDir = () => moduleStateDir("beacon")
export const listenerStatePath = () => join(listenerDir(), "listener.json")
export const listenerLockPath = () => join(listenerDir(), "listener.lock")
export const listenerLogPath = () => join(listenerDir(), "listener.log")
const buttonsPath = () => join(listenerDir(), "buttons.json")
const buttonsLockPath = () => join(listenerDir(), "buttons.lock")

export interface ListenerState {
  channel?: string
  offset?: number
  pid?: number
  version?: string
  startedAt?: string
  // The last time a poll came back from Telegram, ok or not: what the alive
  // check reads.
  lastPollAt?: string
  lastError?: string
  // When polls started failing; cleared by the next good poll.
  failingSince?: string
  lastHandledAt?: string
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

export function readListenerState(): ListenerState {
  return readJson<ListenerState>(listenerStatePath(), {})
}

export function logLine(line: string): void {
  try {
    mkdirSync(listenerDir(), { recursive: true })
    const path = listenerLogPath()
    if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`)
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch {
    // The log is for the operator's curiosity; never let it stop the listener.
  }
}

// ---- routing ------------------------------------------------------------------

export interface Routes {
  commands: Map<string, BeaconCommandDecl>
  actions: Map<string, BeaconActionDecl>
}

export function routesFrom(modules: Pick<ModuleDefinition, "commands" | "actions">[]): Routes {
  const commands = new Map<string, BeaconCommandDecl>()
  const actions = new Map<string, BeaconActionDecl>()
  for (const m of modules) {
    for (const c of m.commands ?? []) commands.set(c.command, c)
    for (const a of m.actions ?? []) actions.set(a.action, a)
  }
  return { commands, actions }
}

export function helpReply(routes: Routes): BeaconReply {
  const lines = [...routes.commands.values()].map((c) => `/${c.command} — ${c.describe}`)
  return { text: lines.length ? `This station answers:\n${lines.join("\n")}` : "This station has no commands yet." }
}

// ---- buttons --------------------------------------------------------------------

interface StoredButton {
  action: string
  payload: Record<string, string>
  createdAt: string
}

// The tick and Sentinel's worker store buttons while the listener takes them, so
// each read-modify-write holds this. It's held for a millisecond, and a button
// is worth more than the lock: past the wait, go ahead without it.
function withButtons<T>(fn: () => T): T {
  let lock: HeldLock | null = null
  for (let i = 0; i < 100 && !lock; i++) {
    lock = tryLock(buttonsLockPath())
    if (!lock) Bun.sleepSync(10)
  }
  try {
    return fn()
  } finally {
    lock?.release()
  }
}

export function storeButton(action: string, payload: Record<string, string>, now = new Date()): string {
  return withButtons(() => {
    const all = readJson<Record<string, StoredButton>>(buttonsPath(), {})
    for (const [k, b] of Object.entries(all)) if (now.getTime() - Date.parse(b.createdAt) > BUTTON_TTL_MS) delete all[k]
    const token = randomBytes(6).toString("base64url")
    all[token] = { action, payload, createdAt: now.toISOString() }
    writeJson(buttonsPath(), all)
    return token
  })
}

export function buttonMarkup(buttons: BeaconButton[][], now = new Date()): string {
  return JSON.stringify({ inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: `b:${storeButton(b.action, b.payload, now)}` }))) })
}

// The button for `token`, removed so it can't be used twice.
export function takeButton(token: string): StoredButton | null {
  return withButtons(() => {
    const all = readJson<Record<string, StoredButton>>(buttonsPath(), {})
    const b = all[token]
    if (!b) return null
    delete all[token]
    writeJson(buttonsPath(), all)
    return b
  })
}

// ---- Telegram -----------------------------------------------------------------

interface TgUser {
  id: number
}
interface TgChat {
  id: number
  type: string
}
interface TgMessage {
  message_id: number
  date: number // unix seconds
  chat: TgChat
  from?: TgUser
  text?: string
}
export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string }
}

export interface ListenContext {
  channel: BeaconChannel
  routes: Routes
  fetchImpl?: Fetch
  now?: () => Date
}

// Link previews off. Buttons go on the last part when a reply is long enough to
// be split. If Telegram refuses a part's HTML, it goes again as plain text: a
// reply that looks plainer beats no reply.
export async function sendReply(ctx: ListenContext, reply: BeaconReply): Promise<string | null> {
  const parts = splitMessage(reply.text)
  for (let i = 0; i < parts.length; i++) {
    const params: Record<string, string> = { chat_id: ctx.channel.chatId, text: parts[i]!, disable_web_page_preview: "true" }
    if (i === parts.length - 1 && reply.buttons?.length) {
      params.reply_markup = buttonMarkup(reply.buttons, ctx.now?.() ?? new Date())
    }
    if (reply.html) params.parse_mode = "HTML"
    let r = await telegramCall(ctx.channel.botToken, "sendMessage", params, ctx.fetchImpl)
    if (!r.ok && reply.html && r.status === 400) {
      const { parse_mode: _html, ...plain } = params
      r = await telegramCall(ctx.channel.botToken, "sendMessage", { ...plain, text: htmlToPlain(parts[i]!) }, ctx.fetchImpl)
    }
    if (!r.ok) return r.error ?? "send failed"
  }
  return null
}

async function run(what: string, fn: () => Promise<BeaconReply>): Promise<BeaconReply> {
  try {
    return await fn()
  } catch (err) {
    logLine(`${what} threw: ${(err as Error).message}`)
    return { text: `${what} failed: ${(err as Error).message}` }
  }
}

export type Handled =
  | { kind: "ignored"; why: string }
  | { kind: "command"; command: string; replied: string | null }
  | { kind: "tap"; action: string | null; replied: string | null }

// Act on one update. The caller has already saved the offset past it.
export async function handleUpdate(u: TgUpdate, ctx: ListenContext): Promise<Handled> {
  const operator = ctx.channel.chatId
  const now = ctx.now?.() ?? new Date()

  if (u.callback_query) {
    const q = u.callback_query
    if (String(q.from.id) !== operator || String(q.message?.chat.id) !== operator) return { kind: "ignored", why: `tap from ${q.from.id}` }
    const token = q.data?.startsWith("b:") ? q.data.slice(2) : ""
    const b = token ? takeButton(token) : null
    const action = b ? ctx.routes.actions.get(b.action) : undefined
    // Answer the tap first: Telegram shows a spinner on the button until we do.
    await telegramCall(ctx.channel.botToken, "answerCallbackQuery", { callback_query_id: q.id, ...(b ? {} : { text: "This button has already been used or has expired." }) }, ctx.fetchImpl)
    if (!b) return { kind: "tap", action: null, replied: null }
    if (!action) {
      const replied = await sendReply(ctx, { text: `Nothing on this station handles "${b.action}" any more.` })
      return { kind: "tap", action: b.action, replied }
    }
    const reply = await run(b.action, () => action.run(b.payload))
    return { kind: "tap", action: b.action, replied: await sendReply(ctx, reply) }
  }

  const m = u.message
  if (!m) return { kind: "ignored", why: "not a message or a tap" }
  if (m.chat.type !== "private" || String(m.chat.id) !== operator || String(m.from?.id) !== operator) {
    return { kind: "ignored", why: `message from ${m.from?.id ?? "?"} in chat ${m.chat.id}` }
  }
  const text = (m.text ?? "").trim()
  if (!text.startsWith("/")) {
    return { kind: "command", command: "", replied: await sendReply(ctx, helpReply(ctx.routes)) }
  }
  // "/jobs", "/jobs@my_bot", "/Jobs extra words"
  const command = text.slice(1).split(/[\s@]/)[0]!.toLowerCase()
  if (now.getTime() - m.date * 1000 > STALE_COMMAND_MS) return { kind: "ignored", why: `/${command} sent ${new Date(m.date * 1000).toISOString()}, too old to answer` }
  const decl = ctx.routes.commands.get(command)
  const reply = decl ? await run(`/${command}`, () => decl.run()) : helpReply(ctx.routes)
  return { kind: "command", command, replied: await sendReply(ctx, reply) }
}

// ---- the loop --------------------------------------------------------------------

export function runningVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string }).version
  } catch {
    return "?"
  }
}

export type ListenExit = { ok: true; reason: "upgraded" | "stopped" } | { ok: false; reason: "locked" | "bad_channel"; message: string }

export interface ListenOptions extends ListenContext {
  channelName: string
  signal?: AbortSignal
  // Testing hooks.
  sleep?: (ms: number) => Promise<unknown>
  version?: () => string
}

export function channelProblem(channel: BeaconChannel): string | null {
  // Telegram's private chats have positive ids; groups and channels negative.
  if (!/^\d+$/.test(channel.chatId)) return "The listener answers only a private chat with the bot, so it can tell the operator apart; this channel pages a group or channel."
  return null
}

export async function listen(opts: ListenOptions): Promise<ListenExit> {
  const problem = channelProblem(opts.channel)
  if (problem) return { ok: false, reason: "bad_channel", message: problem }
  const lock = tryLock(listenerLockPath())
  if (!lock) return { ok: false, reason: "locked", message: "A Beacon listener is already running on this machine." }
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const version = opts.version ?? runningVersion
  const started = version()
  const saved = readListenerState()
  // A different bot or chat means the saved offset belongs to someone else.
  let state: ListenerState = {
    ...(saved.channel === opts.channelName ? { offset: saved.offset } : {}),
    channel: opts.channelName,
    pid: process.pid,
    version: started,
    startedAt: new Date().toISOString(),
  }
  const save = (patch: Partial<ListenerState>) => {
    state = { ...state, ...patch }
    writeJson(listenerStatePath(), state)
  }
  save({})
  logLine(`listening on ${opts.channelName} (pid ${process.pid}, ${started})`)
  let backoff = 5_000
  try {
    while (!opts.signal?.aborted) {
      if (version() !== started) {
        logLine(`SpinupTUI changed from ${started} to ${version()}; exiting so launchd restarts the new version`)
        return { ok: true, reason: "upgraded" }
      }
      const r = await telegramCall(
        opts.channel.botToken,
        "getUpdates",
        {
          ...(state.offset !== undefined ? { offset: String(state.offset) } : {}),
          timeout: String(POLL_SECONDS),
          allowed_updates: JSON.stringify(["message", "callback_query"]),
        },
        opts.fetchImpl,
        { timeoutMs: (POLL_SECONDS + 15) * 1000, signal: opts.signal },
      )
      if (opts.signal?.aborted) break
      if (!r.ok) {
        save({ lastPollAt: new Date().toISOString(), lastError: r.error, failingSince: state.failingSince ?? new Date().toISOString() })
        // 409: something else is reading the bot's updates (Beacon setup's chat
        // discovery, or a second copy elsewhere). Give it room.
        const wait = r.status === 409 ? 30_000 : r.status === 401 || r.status === 404 ? 5 * 60_000 : backoff
        logLine(`poll failed (${r.status || "network"}): ${r.error}; retrying in ${Math.round(wait / 1000)} s`)
        backoff = Math.min(backoff * 2, 60_000)
        await sleep(wait)
        continue
      }
      backoff = 5_000
      save({ lastPollAt: new Date().toISOString(), lastError: undefined, failingSince: undefined })
      for (const u of (r.result as TgUpdate[] | undefined) ?? []) {
        save({ offset: u.update_id + 1 })
        const h = await handleUpdate(u, opts)
        save({ lastHandledAt: new Date().toISOString() })
        if (h.kind === "ignored") logLine(`ignored update ${u.update_id}: ${h.why}`)
        else if (h.kind === "command") logLine(`/${h.command || "(text)"} answered${h.replied ? ` but the reply failed: ${h.replied}` : ""}`)
        else logLine(`tap ${h.action ?? "(used or expired button)"}${h.replied ? `, reply failed: ${h.replied}` : ""}`)
      }
    }
    return { ok: true, reason: "stopped" }
  } finally {
    lock.release()
  }
}

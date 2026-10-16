// `spinuptui beacon …` and `spinuptui modules` — the CLI over lib/beacon.ts and
// the module registry.
//
// Exit codes for `beacon send` are a contract callers branch on: 0 delivered;
// 1 usage error or not configured (nothing was attempted, so a caller may fall
// back to its own sender); 2 delivery failed after retries (Beacon tried — a
// caller must not resend through another path, or a partial multi-part send
// would be duplicated).

import { readFileSync } from "node:fs"
import { loadConfig, saveConfig, type BeaconStored } from "../config.ts"
import {
  beaconFromConfig,
  beaconSend,
  maskChatId,
  maskToken,
  parseEnvFile,
  pickChannel,
  telegramGetMe,
  testMessage,
} from "./beacon.ts"
import { beaconModule } from "../modules/beacon.ts"
import { allModuleStatuses } from "../modules/index.ts"
import type { ModuleStatus } from "../modules/contract.ts"

const VALUE_FLAGS = new Set(["--to", "--env-file"])

function parse(list: string[]): { positionals: string[]; flags: Map<string, string>; rest: string | null } {
  const dash = list.indexOf("--")
  const head = dash === -1 ? list : list.slice(0, dash)
  const positionals: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!
    if (a.startsWith("-") && a !== "-") {
      if (VALUE_FLAGS.has(a)) {
        flags.set(a, head[i + 1] ?? "")
        i++
      } else flags.set(a, "")
      continue
    }
    positionals.push(a)
  }
  return { positionals, flags, rest: dash === -1 ? null : list.slice(dash + 1).join(" ") }
}

function fail(json: boolean, reason: string, message: string, remedy?: string): number {
  if (json) console.log(JSON.stringify({ ok: false, reason, message, ...(remedy ? { remedy } : {}) }))
  else {
    console.error(message)
    if (remedy) console.error(remedy)
  }
  return 1
}

const USAGE = `Usage:
  spinuptui beacon send [--to <channel>] [--silent] [--json] [<message> | -]
  spinuptui beacon add telegram <name> [--env-file <path>] [--default] [--no-test]
  spinuptui beacon remove <name>
  spinuptui beacon test [--to <channel>] [--json]
  spinuptui beacon status [--json]`

function badValue(flags: Map<string, string>, name: string): boolean {
  if (!flags.has(name)) return false
  const v = flags.get(name)!
  return !v || v.startsWith("-")
}

export async function runBeacon(argv: string[]): Promise<number> {
  const { positionals, flags, rest } = parse(argv)
  const json = flags.has("--json")
  const sub = positionals[0]
  for (const f of VALUE_FLAGS) if (badValue(flags, f)) return fail(json, "usage", `${f} needs a value.\n${USAGE}`)

  if (sub === "send") return send(positionals.slice(1), flags, rest, json)
  if (sub === "test") return test(flags, json)
  if (sub === "add") return add(positionals.slice(1), flags, json)
  if (sub === "remove") return remove(positionals.slice(1), json)
  if (sub === "status") return status(json)
  return fail(json, "usage", USAGE)
}

async function send(pos: string[], flags: Map<string, string>, rest: string | null, json: boolean): Promise<number> {
  // The message: everything after `--`, else the positionals, else stdin when it
  // is `-` or absent and stdin isn't a terminal.
  let text: string
  if (rest !== null) text = rest
  else if (pos.length > 0 && !(pos.length === 1 && pos[0] === "-")) text = pos.join(" ")
  else if (pos[0] === "-" || !process.stdin.isTTY) text = await Bun.stdin.text()
  else return fail(json, "usage", `No message: pass it as an argument or pipe it on stdin.\n${USAGE}`)
  text = text.replace(/\s+$/, "")

  const result = await beaconSend(beaconFromConfig(loadConfig()), text, {
    to: flags.get("--to") ?? null,
    silent: flags.has("--silent"),
  })
  if (json) console.log(JSON.stringify(result))
  else if (!result.ok) {
    console.error(result.message)
    if (result.remedy) console.error(result.remedy)
  }
  if (result.ok) return 0
  return result.reason === "delivery_failed" ? 2 : 1
}

async function test(flags: Map<string, string>, json: boolean): Promise<number> {
  const result = await beaconSend(beaconFromConfig(loadConfig()), testMessage(), { to: flags.get("--to") ?? null })
  if (json) console.log(JSON.stringify(result))
  else if (result.ok) console.log(`Test message sent via ${result.channel}.`)
  else {
    console.error(result.message)
    if (result.remedy) console.error(result.remedy)
  }
  if (result.ok) return 0
  return result.reason === "delivery_failed" ? 2 : 1
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

async function add(pos: string[], flags: Map<string, string>, json: boolean): Promise<number> {
  const [type, name] = pos
  if (type !== "telegram" || !name) return fail(json, "usage", USAGE)
  if (!NAME_RE.test(name)) return fail(json, "usage", `Channel names are lowercase letters, digits and dashes (got "${name}").`)
  if (name === "env") return fail(json, "usage", `"env" is reserved for the channel defined by SPINUPTUI_BEACON_* environment variables.`)

  // Secrets come from a file or the environment, never argv (where `ps` shows them).
  let source: Record<string, string | undefined> = process.env
  const envFile = flags.get("--env-file")
  if (envFile) {
    try {
      source = parseEnvFile(readFileSync(envFile, "utf8"))
    } catch (err) {
      return fail(json, "env_file_unreadable", `Couldn't read ${envFile}: ${(err as Error).message}`)
    }
  }
  const botToken = source.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = source.TELEGRAM_CHAT_ID?.trim()
  if (!botToken || !chatId) {
    return fail(
      json,
      "missing_credentials",
      `TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set ${envFile ? `in ${envFile}` : "in the environment"}.`,
      "Put them in a KEY=VALUE file and pass --env-file <path>.",
    )
  }

  // Credentials that can't deliver are never stored.
  const me = await telegramGetMe(botToken)
  if (!me.ok) {
    if (json) console.log(JSON.stringify({ ok: false, reason: "token_rejected", message: `Telegram rejected the bot token: ${me.error}` }))
    else console.error(`Telegram rejected the bot token: ${me.error}`)
    return 2
  }
  const channel = { type: "telegram" as const, botToken, chatId }
  if (!flags.has("--no-test")) {
    const r = await beaconSend(
      { channels: [{ name, channel, env: false }], defaultChannel: name },
      `Beacon connected: channel "${name}" will page this chat.`,
      { log: false },
    )
    if (!r.ok) {
      if (json) console.log(JSON.stringify({ ...r, message: `Not saved. ${r.message}` }))
      else console.error(`Not saved. ${r.message}`)
      return 2
    }
  }

  const stored: BeaconStored = loadConfig().beacon ?? {}
  const channels = { ...(stored.channels ?? {}), [name]: channel }
  const makeDefault = flags.has("--default") || !stored.defaultChannel
  await saveConfig({ beacon: { ...stored, channels, ...(makeDefault ? { defaultChannel: name } : {}) } })
  const summary = {
    ok: true,
    channel: name,
    bot: me.username ? `@${me.username}` : maskToken(botToken),
    chat: maskChatId(chatId),
    default: makeDefault ? name : stored.defaultChannel,
    tested: !flags.has("--no-test"),
  }
  if (json) console.log(JSON.stringify(summary))
  else console.log(`Saved channel "${name}" (${summary.bot} → chat ${summary.chat})${makeDefault ? ", now the default" : ""}.`)
  return 0
}

async function remove(pos: string[], json: boolean): Promise<number> {
  const name = pos[0]
  if (!name) return fail(json, "usage", USAGE)
  const stored: BeaconStored = loadConfig().beacon ?? {}
  if (!stored.channels?.[name]) {
    const resolved = pickChannel(beaconFromConfig(loadConfig()), name)
    if (!("ok" in resolved) && resolved.env) {
      return fail(json, "read_only", `"${name}" comes from SPINUPTUI_BEACON_* environment variables; unset them to remove it.`)
    }
    return fail(json, "unknown_channel", `No stored Beacon channel named "${name}".`)
  }
  const { [name]: _gone, ...channels } = stored.channels
  const next: BeaconStored = { ...stored, channels }
  if (next.defaultChannel === name) delete next.defaultChannel
  await saveConfig({ beacon: next })
  if (json) console.log(JSON.stringify({ ok: true, removed: name }))
  else console.log(`Removed channel "${name}".`)
  return 0
}

function printStatus(s: ModuleStatus & { name?: string }): void {
  console.log(`${s.name ?? s.id}: ${s.state} — ${s.summary}`)
  for (const c of s.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
  if (s.remedy) console.log(`  → ${s.remedy}`)
}

async function status(json: boolean): Promise<number> {
  const s = await beaconModule.status()
  if (json) console.log(JSON.stringify({ ok: true, ...s }))
  else printStatus({ ...s, name: beaconModule.name })
  return 0
}

export async function runModules(argv: string[]): Promise<number> {
  const json = argv.includes("--json")
  const statuses = await allModuleStatuses()
  if (json) console.log(JSON.stringify({ ok: true, modules: statuses }))
  else for (const s of statuses) printStatus(s)
  return 0
}

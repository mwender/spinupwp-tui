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
import { beaconFromConfig, beaconSend, maskChatId, maskToken, parseEnvFile, pickChannel, telegramGetMe, testMessage } from "./beacon.ts"
import {
  BOTFATHER_STEPS,
  botLink,
  channelExists,
  discoverChat,
  saveBeaconChannel,
  sendConnectedMessage,
  setupChannelName,
  verifyBotToken,
} from "./beaconSetup.ts"
import { boardLogin } from "./beaconBoard.ts"
import { confirm, PromptCancelled, readLine } from "./prompt.ts"
import { listen, routesFrom } from "./beaconListen.ts"
import {
  applyListenerInstall,
  applyListenerUninstall,
  binHasListener,
  listenerHealth,
  NO_LISTENER,
  pauseListener,
  planListenerInstall,
  planListenerUninstall,
} from "./beaconListenInstall.ts"
import { MODULES } from "../modules/index.ts"
import { beaconModule } from "../modules/beacon.ts"
import { allModuleStatuses, UPCOMING_MODULES } from "../modules/index.ts"
import type { ModuleStatus } from "../modules/contract.ts"

const VALUE_FLAGS = new Set(["--to", "--env-file", "--bin", "--project", "--mention"])

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
  spinuptui beacon setup [<name>]   (guided, in a terminal)
  spinuptui beacon send [--to <channel>] [--silent] [--json] [<message> | -]
  spinuptui beacon add telegram <name> [--env-file <path>] [--default] [--no-test]
  spinuptui beacon add basecamp <name> --project <id> [--mention "<person>"]
                          a team message board: the \`basecamp\` CLI must be logged in
  spinuptui beacon remove <name>
  spinuptui beacon test [--to <channel>] [--json]
  spinuptui beacon status [--json]
  spinuptui beacon listen [--to <channel>]   answer the operator: /jobs, button taps (foreground)
  spinuptui beacon listener install | uninstall --plan | --apply [--to <channel>] [--bin <path>]
  spinuptui beacon listener status | check   is it running? (check exits 1 when it isn't)`

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

  if (sub === "setup") return setup(positionals.slice(1))
  if (sub === "send") return send(positionals.slice(1), flags, rest, json)
  if (sub === "test") return test(flags, json)
  if (sub === "add") return add(positionals.slice(1), flags, json)
  if (sub === "remove") return remove(positionals.slice(1), json)
  if (sub === "status") return status(json)
  if (sub === "listen") return listenCmd(flags)
  if (sub === "listener") return listener(positionals.slice(1), flags, json)
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

async function addBoard(name: string, flags: Map<string, string>, json: boolean): Promise<number> {
  const projectId = flags.get("--project") ?? ""
  if (!/^\d+$/.test(projectId)) return fail(json, "usage", `--project needs the Basecamp project's numeric id.\n${USAGE}`)
  const login = await boardLogin()
  if (!login.ok) return fail(json, "basecamp_login", `Can't reach Basecamp: ${login.detail}.`)
  const mention = flags.get("--mention")
  const stored: BeaconStored = loadConfig().beacon ?? {}
  await saveConfig({ beacon: { ...stored, boards: { ...(stored.boards ?? {}), [name]: { type: "basecamp", projectId, audience: "team", ...(mention ? { mention } : {}) } } } })
  if (json) console.log(JSON.stringify({ ok: true, board: name, projectId }))
  else console.log(`Added team board "${name}" (Basecamp project ${projectId}), posting as ${login.detail}.`)
  return 0
}

async function add(pos: string[], flags: Map<string, string>, json: boolean): Promise<number> {
  const [type, name] = pos
  if (type === "basecamp" && name && NAME_RE.test(name)) return addBoard(name, flags, json)
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
    const r = await sendConnectedMessage(name, channel)
    if (!r.ok) {
      if (json) console.log(JSON.stringify({ ...r, message: `Not saved. ${r.message}` }))
      else console.error(`Not saved. ${r.message}`)
      return 2
    }
  }

  const previousDefault = loadConfig().beacon?.defaultChannel
  const { isDefault } = await saveBeaconChannel(name, channel, flags.has("--default"))
  const summary = {
    ok: true,
    channel: name,
    bot: me.username ? `@${me.username}` : maskToken(botToken),
    chat: maskChatId(chatId),
    default: isDefault ? name : previousDefault,
    tested: !flags.has("--no-test"),
  }
  if (json) console.log(JSON.stringify(summary))
  else console.log(`Saved channel "${name}" (${summary.bot} → chat ${summary.chat})${isDefault ? ", now the default" : ""}.`)
  return 0
}

// The guided path for someone without a bot yet. Interactive only: scripts and
// provisioning use `add --env-file`.
async function setup(pos: string[]): Promise<number> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return fail(false, "needs_terminal", "`beacon setup` is interactive and needs a terminal.", "For scripts, use `spinuptui beacon add telegram <name> --env-file <path>`.")
  }
  const name = pos[0] ?? setupChannelName()
  if (!NAME_RE.test(name) || name === "env") return fail(false, "usage", `"${name}" can't be a channel name (lowercase letters, digits and dashes; "env" is reserved).`)
  const say = (line = "") => process.stderr.write(line + "\n")
  try {
    say("Beacon setup: page yourself on Telegram.")
    say()
    if (channelExists(name) && !(await confirm(`A channel named "${name}" already exists. Replace it?`, false))) return 1

    say("1. Create a bot (skip if you already have one):")
    for (const step of BOTFATHER_STEPS) say(`   · ${step}`)
    say()
    let token = ""
    let username = ""
    for (let attempt = 0; ; attempt++) {
      token = (await readLine("2. Paste the bot token (hidden): ", { hidden: true })).trim()
      const me = await verifyBotToken(token)
      if (me.ok) {
        username = me.username ?? ""
        say(`   ✓ Bot ${username ? `@${username}` : "found"}`)
        break
      }
      say(`   ✗ ${me.error}`)
      if (attempt >= 2) return 2
    }
    say()
    for (;;) {
      say(`3. In Telegram, send any message to ${username ? `@${username} (${botLink(username)})` : "your bot"}.`)
      say("   To page a group instead, add the bot to the group and send /start there.")
      say("   Waiting up to 5 minutes… (Ctrl-C to cancel)")
      // Telegram gives a bot's messages to one reader: stop the listener meanwhile.
      const resume = await pauseListener()
      const found = await discoverChat(token).finally(resume)
      if (!found.ok) {
        say(`   ✗ ${found.message}`)
        if (found.reason === "timeout" && (await confirm("   Keep waiting?", true))) continue
        return found.reason === "cancelled" ? 1 : 2
      }
      say(`   ✓ Found: ${found.chat.label} (${found.chat.kind} chat)`)
      if (!(await confirm("   Page this chat?", true))) continue
      const channel = { type: "telegram" as const, botToken: token, chatId: found.chat.chatId }
      const sent = await sendConnectedMessage(name, channel)
      if (!sent.ok) {
        say(`   ✗ Couldn't send the test message: ${sent.message}. Nothing was saved.`)
        return 2
      }
      const { isDefault } = await saveBeaconChannel(name, channel, false)
      say()
      say(`✓ Saved channel "${name}"${isDefault ? " (the default)" : ""}. A test message is on its way to that chat.`)
      say(`  Try it: spinuptui beacon send "hello from $(hostname)"`)
      return 0
    }
  } catch (err) {
    if (err instanceof PromptCancelled) {
      say("Cancelled; nothing was saved.")
      return 1
    }
    throw err
  }
}

async function remove(pos: string[], json: boolean): Promise<number> {
  const name = pos[0]
  if (!name) return fail(json, "usage", USAGE)
  const stored: BeaconStored = loadConfig().beacon ?? {}
  if (stored.boards?.[name]) {
    const { [name]: _board, ...boards } = stored.boards
    await saveConfig({ beacon: { ...stored, boards } })
    if (json) console.log(JSON.stringify({ ok: true, removed: name }))
    else console.log(`Removed board "${name}".`)
    return 0
  }
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
  const upcoming = UPCOMING_MODULES.map(({ id, name, summary }) => ({ id, name, about: summary }))
  if (json) console.log(JSON.stringify({ ok: true, modules: statuses, upcoming }))
  else {
    for (const s of statuses) printStatus(s)
    console.log(`Coming soon: ${upcoming.map((u) => u.name).join(", ")}`)
  }
  return 0
}

// ---- the listener ----------------------------------------------------------------

async function listenCmd(flags: Map<string, string>): Promise<number> {
  const picked = pickChannel(beaconFromConfig(loadConfig()), flags.get("--to") ?? null)
  if ("ok" in picked) return fail(false, picked.reason, picked.message, picked.remedy)
  const ctrl = new AbortController()
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => ctrl.abort())
  if (process.env.SPINUPTUI_BEACON_LISTENER !== "1") process.stderr.write(`Listening on "${picked.name}" for /commands and button taps (Ctrl-C to stop)…\n`)
  const r = await listen({ channel: picked.channel, channelName: picked.name, routes: routesFrom(MODULES), signal: ctrl.signal })
  if (!r.ok) return fail(false, r.reason, r.message)
  return 0
}

async function listener(pos: string[], flags: Map<string, string>, json: boolean): Promise<number> {
  const sub = pos[0]
  if (sub === "status" || sub === "check") {
    const h = listenerHealth()
    if (json) console.log(JSON.stringify({ ok: h?.ok ?? true, installed: h !== null, ...(h ? { detail: h.detail } : {}) }))
    else if (!h) console.log("Beacon's listener isn't installed on this machine.")
    else console.log(`${h.ok ? "✓" : "✗"} Beacon's listener ${h.detail}`)
    if (sub === "check" && h && !h.ok && !json) console.log("Reinstall it with `spinuptui beacon listener install --apply`, or from the Modules tab.")
    return sub === "check" && h && !h.ok ? 1 : 0
  }
  const apply = flags.has("--apply")
  if ((sub !== "install" && sub !== "uninstall") || apply === flags.has("--plan")) {
    return fail(json, "usage", "Usage: spinuptui beacon listener install | uninstall --plan | --apply, or listener status | check")
  }
  if (sub === "uninstall") {
    const plan = planListenerUninstall()
    if (!apply) {
      if (json) console.log(JSON.stringify({ ok: true, ...plan }))
      else {
        if (!plan.installed) console.log("Beacon's listener isn't installed; nothing to remove.")
        for (const c of plan.commands) console.log(`  · ${c}`)
      }
      return 0
    }
    const r = await applyListenerUninstall(plan)
    if (json) console.log(JSON.stringify(r))
    else console.log(`Removed ${plan.label}. The pager still sends; it just won't answer.`)
    return 0
  }
  const plan = planListenerInstall({ bin: flags.get("--bin") ?? null, to: flags.get("--to") ?? null })
  if (!plan.ok) return fail(json, plan.reason, plan.message, plan.remedy)
  // Refuse at --plan too, so a plan that can't work is never shown as one.
  if (!(await binHasListener(plan))) return fail(json, NO_LISTENER.reason, NO_LISTENER.message, NO_LISTENER.remedy)
  if (!apply) {
    if (json) console.log(JSON.stringify(plan))
    else {
      console.log(`Would install Beacon's listener (${plan.label}), kept running by launchd:\n`)
      console.log(`  ${plan.programArguments.join(" ")}\n`)
      console.log(`Unit: ${plan.unitPath}\n`)
      console.log("Steps:")
      for (const c of plan.commands) console.log(`  · ${c}`)
      for (const n of plan.notes) console.log(`Note: ${n}`)
      console.log(`\nRun with --apply to install it.`)
    }
    return 0
  }
  const r = await applyListenerInstall(plan, (line) => process.stderr.write(`→ ${line}\n`))
  if (!r.ok) return fail(json, r.reason, r.message, r.remedy)
  if (json) console.log(JSON.stringify(r))
  else {
    console.log(`Installed ${r.label}; it's listening on "${r.channel}". Send /jobs to the bot to try it.`)
    for (const n of r.notes) console.log(`Note: ${n}`)
  }
  return 0
}

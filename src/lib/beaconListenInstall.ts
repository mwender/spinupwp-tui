// Installing Beacon's listener: a resident LaunchAgent (KeepAlive) running
// `spinuptui beacon listen`, so macOS restarts it if it dies. It's the station's
// one unit besides Scheduler's dispatcher; it does no scheduled work, it only
// waits for the operator. Scheduler's tick runs `beacon listener check` (a
// Beacon module job) and pages when the listener stops answering.

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { loadConfig, saveConfig } from "../config.ts"
import { beaconFromConfig, beaconSend, pickChannel } from "./beacon.ts"
import { buttonMarkup, channelProblem, listenerDir, listenerLogPath, readListenerState } from "./beaconListen.ts"
import { helpIncludes, launchctl, resolveRunner } from "./schedulerInstall.ts"
import type { BeaconButton } from "../modules/contract.ts"

export const DEFAULT_LISTENER_LABEL = "com.spinuptui.beacon-listener"
// Three missed polls, with room for a restart.
export const LISTENER_STALE_MS = 5 * 60_000
// A poll that keeps failing this long (Telegram unreachable, another reader of
// the bot) counts as down too; one blip doesn't.
export const LISTENER_FAILING_MS = 10 * 60_000

// Set while Beacon setup has the listener stopped, so the alive check doesn't
// page about a pause the operator asked for.
const pausedPath = () => join(listenerDir(), "listener.paused")
const PAUSE_MAX_MS = 30 * 60_000

export function listenerLabel(): string {
  return process.env.SPINUPTUI_LISTENER_LABEL?.trim() || DEFAULT_LISTENER_LABEL
}

const domain = () => `gui/${process.getuid?.() ?? 501}`
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function renderListenerPlist(p: { label: string; programArguments: string[]; env: Record<string, string>; logPath: string }): string {
  const args = p.programArguments.map((a) => `    <string>${xml(a)}</string>`).join("\n")
  const env = Object.entries(p.env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  SpinupTUI Beacon's listener: \`spinuptui beacon listen\`, kept running so the
  pager can answer you (/jobs and button taps). Written by
  \`spinuptui beacon listener install --apply\`; remove it with
  \`spinuptui beacon listener uninstall --apply\` rather than by hand.
-->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(p.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(p.logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(p.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`
}

export interface ListenerPlan {
  label: string
  unitPath: string
  bin: string
  channel: string
  programArguments: string[]
  env: Record<string, string>
  unitText: string
  commands: string[]
  notes: string[]
}

export type ListenerPlanResult = ({ ok: true } & ListenerPlan) | { ok: false; reason: string; message: string; remedy?: string }

export function planListenerInstall(opts: { bin?: string | null; to?: string | null } = {}): ListenerPlanResult {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "unsupported_platform", message: "The listener installs as a macOS LaunchAgent; Linux isn't supported yet." }
  }
  const picked = pickChannel(beaconFromConfig(loadConfig()), opts.to)
  if ("ok" in picked) return { ok: false, reason: picked.reason, message: picked.message, remedy: picked.remedy ?? "Set up Beacon first: spinuptui beacon setup" }
  if (picked.env) {
    return {
      ok: false,
      reason: "env_channel",
      message: "The default channel comes from SPINUPTUI_BEACON_* in this shell, which the LaunchAgent won't have.",
      remedy: "Save the channel with `spinuptui beacon setup` (or `beacon add`) and install again.",
    }
  }
  const problem = channelProblem(picked.channel)
  if (problem) return { ok: false, reason: "group_chat", message: problem, remedy: "Point a channel at your private chat with the bot (spinuptui beacon setup), then install with --to <that channel>." }
  const runner = resolveRunner(opts)
  if (!runner.ok) return runner
  const label = listenerLabel()
  const programArguments = [...runner.prefix, "beacon", "listen", "--to", picked.name]
  const env = { ...runner.env, SPINUPTUI_BEACON_LISTENER: "1" }
  const unitPath = join(homedir(), "Library/LaunchAgents", `${label}.plist`)
  const notes = [
    `It answers only your private chat with the bot on channel "${picked.name}", and ignores everyone else.`,
    "It long-polls Telegram (about one request a minute when idle) and restarts itself after you upgrade SpinupTUI.",
    "Scheduler's tick checks it's alive and pages you if it isn't, so install Scheduler too.",
  ]
  if (runner.checkout) notes.push(`--bin points into a checkout (${runner.checkout}); fine for testing, never for a station.`)
  return {
    ok: true,
    label,
    unitPath,
    bin: runner.bin,
    channel: picked.name,
    programArguments,
    env,
    unitText: renderListenerPlist({ label, programArguments, env, logPath: join(listenerDir(), "launchd.log") }),
    commands: [`launchctl bootout ${domain()}/${label}  (if loaded)`, `launchctl bootstrap ${domain()} ${unitPath}`, "wait for the listener to start (up to 60 s)", "send a message saying it's listening"],
    notes,
  }
}

export type ListenerApplyResult =
  | { ok: true; label: string; unitPath: string; channel: string; startedAt: string; notes: string[] }
  | { ok: false; reason: string; message: string; remedy?: string; unitPath?: string }

// Asked through --help, as for Scheduler's dispatcher: a release without the
// listener treats `beacon listen` as an unknown subcommand.
export function binHasListener(plan: Pick<ListenerPlan, "programArguments" | "env">): Promise<boolean> {
  return helpIncludes(plan.programArguments.slice(0, -4), plan.env.PATH ?? "", "spinuptui beacon listen")
}

export const NO_LISTENER = {
  ok: false as const,
  reason: "spinuptui_too_old",
  message: "The `spinuptui` the LaunchAgent would run doesn't have Beacon's listener yet.",
  remedy: "Install a release that has it first: bun add -g spinuptui@next --no-cache",
}

export async function applyListenerInstall(plan: ListenerPlan, onStage: (s: string) => void = () => {}): Promise<ListenerApplyResult> {
  onStage("checking that this spinuptui has the listener")
  if (!(await binHasListener(plan))) return NO_LISTENER
  mkdirSync(dirname(plan.unitPath), { recursive: true })
  mkdirSync(listenerDir(), { recursive: true })
  onStage(`writing ${plan.unitPath}`)
  writeFileSync(plan.unitPath, plan.unitText, { mode: 0o644 })
  await launchctl("bootout", `${domain()}/${plan.label}`)
  const since = Date.now()
  onStage("loading it with launchctl")
  const boot = await launchctl("bootstrap", domain(), plan.unitPath)
  if (boot.code !== 0) return { ok: false, reason: "launchctl_failed", message: `launchctl bootstrap failed: ${boot.out}`, unitPath: plan.unitPath }
  const beacon = loadConfig().beacon ?? {}
  await saveConfig({ beacon: { ...beacon, listener: { label: plan.label, unitPath: plan.unitPath, bin: plan.bin, channel: plan.channel, installedAt: new Date().toISOString() } } })

  onStage("waiting for the listener to start")
  for (let waited = 0; waited < 60_000; waited += 1000) {
    const st = readListenerState()
    if (st.startedAt && Date.parse(st.startedAt) >= since) {
      const sent = await beaconSend(beaconFromConfig(loadConfig()), "Beacon is listening on this station. Send /help to see what it answers, or /jobs for the scheduled jobs.", { to: plan.channel })
      const notes = sent.ok ? plan.notes : [...plan.notes, `It's running, but the hello message failed: ${sent.message}`]
      return { ok: true, label: plan.label, unitPath: plan.unitPath, channel: plan.channel, startedAt: st.startedAt, notes }
    }
    await Bun.sleep(1000)
  }
  return {
    ok: false,
    reason: "not_started",
    message: "The listener is installed, but it didn't start within 60 seconds.",
    remedy: `Check ${join(listenerDir(), "launchd.log")} and \`launchctl print ${domain()}/${plan.label}\`.`,
    unitPath: plan.unitPath,
  }
}

export interface ListenerUninstallPlan {
  label: string
  unitPath: string
  installed: boolean
  commands: string[]
}

export function planListenerUninstall(): ListenerUninstallPlan {
  const l = loadConfig().beacon?.listener
  const label = l?.label ?? listenerLabel()
  const unitPath = l?.unitPath ?? join(homedir(), "Library/LaunchAgents", `${label}.plist`)
  return {
    label,
    unitPath,
    installed: !!l || existsSync(unitPath),
    commands: [`launchctl bootout ${domain()}/${label}`, `delete ${unitPath}`, "clear beacon.listener in config.json (channels are kept)"],
  }
}

export async function applyListenerUninstall(plan: ListenerUninstallPlan): Promise<{ ok: true; removed: string }> {
  if (process.platform === "darwin") await launchctl("bootout", `${domain()}/${plan.label}`)
  if (existsSync(plan.unitPath)) unlinkSync(plan.unitPath)
  const b = loadConfig().beacon
  if (b?.listener) {
    const { listener: _gone, ...rest } = b
    await saveConfig({ beacon: rest })
  }
  return { ok: true, removed: plan.unitPath }
}

export function listenerInstalled(): boolean {
  const l = loadConfig().beacon?.listener
  return !!l && existsSync(l.unitPath)
}

// Is the installed listener answering? null when none is installed.
// Inline buttons for a page. Only the listener can receive a tap, so with none
// installed a page goes out without them.
export function pageMarkup(buttons: BeaconButton[][]): string | undefined {
  return listenerInstalled() ? buttonMarkup(buttons) : undefined
}

export function listenerHealth(now = Date.now()): { ok: boolean; detail: string } | null {
  if (!listenerInstalled()) return null
  try {
    const at = Date.parse(readFileSync(pausedPath(), "utf8").trim())
    if (now - at < PAUSE_MAX_MS) return { ok: true, detail: `paused by Beacon setup since ${new Date(at).toISOString()}` }
  } catch {
    // Not paused.
  }
  const st = readListenerState()
  // A listener that just started has a first poll still out (up to 50 seconds),
  // so its start counts as a sign of life too.
  const last = Math.max(...[st.lastPollAt, st.startedAt].map((t) => (t ? Date.parse(t) : 0)))
  if (now - last > LISTENER_STALE_MS) {
    return { ok: false, detail: `hasn't polled Telegram since ${st.lastPollAt ?? "it was installed"}; see ${listenerLogPath()}` }
  }
  if (st.failingSince && now - Date.parse(st.failingSince) > LISTENER_FAILING_MS) {
    return { ok: false, detail: `polls failing since ${st.failingSince}: ${st.lastError ?? "unknown error"}` }
  }
  return { ok: true, detail: `listening on ${st.channel ?? "?"} (pid ${st.pid ?? "?"}, ${st.version ?? "?"}), ${st.lastPollAt ? `last poll ${st.lastPollAt}` : `started ${st.startedAt}`}` }
}

// Telegram hands a bot's updates to one reader at a time, so Beacon setup's chat
// discovery stops the listener while it waits and starts it again after.
export async function pauseListener(): Promise<() => Promise<void>> {
  const l = loadConfig().beacon?.listener
  if (process.platform !== "darwin" || !l || !existsSync(l.unitPath)) return async () => {}
  mkdirSync(listenerDir(), { recursive: true })
  writeFileSync(pausedPath(), new Date().toISOString() + "\n")
  await launchctl("bootout", `${domain()}/${l.label}`)
  return async () => {
    await launchctl("bootstrap", domain(), l.unitPath)
    rmSync(pausedPath(), { force: true })
  }
}

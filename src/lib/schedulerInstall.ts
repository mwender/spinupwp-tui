// Installing Scheduler's dispatcher: the one OS-level scheduled unit SpinupTUI
// owns. macOS gets a LaunchAgent on twelve StartCalendarInterval entries (every
// fifth minute; the calendar scheduler, because StartInterval agents have been
// seen to wedge). Linux gets a systemd user timer, printed by --plan only until
// a Linux station exists to test on. See docs/2026-10-20_scheduler-spec.md.

import { existsSync, mkdirSync, openSync, readSync, closeSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { loadConfig, saveConfig } from "../config.ts"
import { readLastTick, schedulerStateDir } from "./schedulerJobs.ts"
import { moduleWorkDir } from "../modules/contract.ts"
import { spawn } from "./spawn.ts"

export const DEFAULT_LABEL = "com.spinuptui.scheduler"
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
const TOOLS = ["git", "ssh", "claude", "codex"]

export function schedulerLabel(): string {
  return process.env.SPINUPTUI_SCHEDULER_LABEL?.trim() || DEFAULT_LABEL
}

export interface InstallPlan {
  platform: "darwin" | "linux"
  label: string
  unitPath: string
  bin: string
  programArguments: string[]
  env: Record<string, string>
  unitText: string
  extraUnits?: { path: string; text: string }[]
  commands: string[]
  notes: string[]
}

export type PlanResult = ({ ok: true } & InstallPlan) | { ok: false; reason: string; message: string; remedy?: string }

// The checkout a path lives in, if any: a directory with .git above it. A
// package install (node_modules) never counts.
function checkoutOf(path: string): string | null {
  if (path.includes("/node_modules/")) return null
  let dir = dirname(path)
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function shebangOf(path: string): string | null {
  try {
    const fd = openSync(path, "r")
    const buf = Buffer.alloc(128)
    const n = readSync(fd, buf, 0, 128, 0)
    closeSync(fd)
    const head = buf.subarray(0, n).toString("utf8")
    return head.startsWith("#!") ? head.split("\n")[0]! : null
  } catch {
    return null
  }
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function renderPlist(p: { label: string; programArguments: string[]; env: Record<string, string>; logPath: string }): string {
  const minutes = Array.from({ length: 12 }, (_, i) => `    <dict><key>Minute</key><integer>${i * 5}</integer></dict>`).join("\n")
  const args = p.programArguments.map((a) => `    <string>${xml(a)}</string>`).join("\n")
  const env = Object.entries(p.env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  SpinupTUI Scheduler's dispatcher: \`spinuptui scheduler tick\` at login and at
  every fifth minute. Written by \`spinuptui scheduler install --apply\`; remove it
  with \`spinuptui scheduler uninstall --apply\` rather than by hand.
-->
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(p.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <array>
${minutes}
  </array>
  <key>RunAtLoad</key><true/>
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

export function renderSystemd(p: { label: string; programArguments: string[]; env: Record<string, string> }): { service: string; timer: string } {
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, "\\$1")}"`)
  const env = Object.entries(p.env)
    .map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
    .join("\n")
  return {
    service: `[Unit]\nDescription=SpinupTUI Scheduler tick\n\n[Service]\nType=oneshot\nExecStart=${p.programArguments.map(quote).join(" ")}\n${env}\n`,
    timer: `[Unit]\nDescription=SpinupTUI Scheduler, every 5 minutes\n\n[Timer]\nOnCalendar=*:0/5\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  }
}

export function planInstall(opts: { bin?: string | null } = {}): PlanResult {
  const platform = process.platform
  if (platform !== "darwin" && platform !== "linux") {
    return { ok: false, reason: "unsupported_platform", message: `Scheduler's dispatcher supports macOS and Linux, not ${platform}.` }
  }
  const searchPath = [process.env.PATH ?? "", join(homedir(), ".bun/bin")].join(":")
  const bin = opts.bin ?? Bun.which("spinuptui", { PATH: searchPath })
  if (!bin || !existsSync(bin)) {
    return {
      ok: false,
      reason: "spinuptui_not_found",
      message: opts.bin ? `--bin ${opts.bin} does not exist.` : "No global `spinuptui` on the PATH for the dispatcher to run.",
      remedy: "Install it globally first: bun add -g spinuptui",
    }
  }
  let real = bin
  try {
    real = realpathSync(bin)
  } catch {
    // Keep the given path.
  }
  const checkout = checkoutOf(real)
  if (checkout && !opts.bin) {
    return {
      ok: false,
      reason: "checkout_bin",
      message: `The \`spinuptui\` on the PATH (${bin}) runs a development checkout (${checkout}). The dispatcher must run a release, so an unattended tick never runs whatever is checked out.`,
      remedy: "Install a release globally (bun add -g spinuptui), or pass --bin <path> to override deliberately.",
    }
  }
  const shebang = shebangOf(real)
  const bun = /\bbun(\.exe)?$/.test(process.execPath) ? process.execPath : (Bun.which("bun", { PATH: searchPath }) ?? "bun")
  const programArguments = shebang?.includes("bun") ? [bun, bin, "scheduler", "tick"] : [bin, "scheduler", "tick"]

  const dirs: string[] = [dirname(bun), dirname(bin)]
  for (const t of TOOLS) {
    const p = Bun.which(t, { PATH: searchPath })
    // System directories go last, whichever tool was found there first, so they
    // never shadow a newer tool in Homebrew or ~/.local/bin.
    if (p && !SYSTEM_PATH.includes(dirname(p))) dirs.push(dirname(p))
  }
  for (const d of SYSTEM_PATH) if (existsSync(d)) dirs.push(d)
  const env: Record<string, string> = {
    PATH: [...new Set(dirs)].join(":"),
    SPINUPTUI_SCHEDULER_DISPATCHER: "1",
  }
  if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME
  if (process.env.SPINUPTUI_HOME) env.SPINUPTUI_HOME = process.env.SPINUPTUI_HOME
  const label = schedulerLabel()
  // One clock per machine: a dispatcher installed under another label would
  // tick the same jobs alongside this one.
  const existing = loadConfig().scheduler?.dispatcher
  if (existing && existing.label !== label && existsSync(existing.unitPath)) {
    return {
      ok: false,
      reason: "other_dispatcher",
      message: `A Scheduler dispatcher is already installed as ${existing.label}; installing ${label} too would run every job twice.`,
      remedy: "Remove it first: spinuptui scheduler uninstall --apply",
    }
  }
  const notes: string[] = [`Jobs and reports live in ${moduleWorkDir("scheduler")} (created on first use).`]
  if (checkout) notes.push(`--bin points into a checkout (${checkout}); fine for testing, never for a station.`)
  const missing = TOOLS.filter((t) => !Bun.which(t, { PATH: env.PATH }))
  if (missing.length) notes.push(`Not found, so jobs that need them will fail: ${missing.join(", ")}.`)

  if (platform === "darwin") {
    const unitPath = join(homedir(), "Library/LaunchAgents", `${label}.plist`)
    const domain = `gui/${process.getuid?.() ?? 501}`
    notes.push("A LaunchAgent runs only while you're logged in: after a reboot, nothing ticks until someone logs in.")
    return {
      ok: true,
      platform,
      label,
      unitPath,
      bin,
      programArguments,
      env,
      unitText: renderPlist({ label, programArguments, env, logPath: join(schedulerStateDir(), "launchd.log") }),
      commands: [`launchctl bootout ${domain}/${label}  (if loaded)`, `launchctl bootstrap ${domain} ${unitPath}`, "wait for a tick from the dispatcher (up to 60 s)"],
      notes,
    }
  }
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd/user")
  const units = renderSystemd({ label, programArguments, env })
  notes.push("Linux --apply isn't supported yet; these are the units it will write.", "Run `loginctl enable-linger $USER` so the timer runs with nobody logged in.")
  return {
    ok: true,
    platform,
    label,
    unitPath: join(unitDir, `${label}.service`),
    bin,
    programArguments,
    env,
    unitText: units.service,
    extraUnits: [{ path: join(unitDir, `${label}.timer`), text: units.timer }],
    commands: [`systemctl --user daemon-reload`, `systemctl --user enable --now ${label}.timer`],
    notes,
  }
}

// Does the binary the unit will run have Scheduler at all? Asked through
// --help, a capability check rather than a version comparison: every release
// answers --help without starting the dashboard, while one without Scheduler
// treats `scheduler tick` as an unknown subcommand and would launch the TUI
// under launchd every 5 minutes.
export async function binHasScheduler(plan: Pick<InstallPlan, "programArguments" | "env">): Promise<boolean> {
  try {
    const p = spawn([...plan.programArguments.slice(0, -2), "--help"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, PATH: plan.env.PATH ?? "" },
    })
    const timer = setTimeout(() => p.kill(), 30_000)
    const out = await new Response(p.stdout).text()
    await p.exited
    clearTimeout(timer)
    return out.includes("spinuptui scheduler")
  } catch {
    return false
  }
}

export const NO_SCHEDULER = {
  ok: false as const,
  reason: "spinuptui_too_old",
  message: "The `spinuptui` the dispatcher would run doesn't have Scheduler yet, so it would open the dashboard every 5 minutes instead of ticking.",
  remedy: "Install a release that has it first: bun add -g spinuptui@next --no-cache",
}

async function launchctl(...args: string[]): Promise<{ code: number; out: string }> {
  const p = spawn(["launchctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: (out + err).trim() }
}

export type ApplyResult =
  | { ok: true; label: string; unitPath: string; tickAt: string; notes: string[] }
  | { ok: false; reason: string; message: string; remedy?: string; unitPath?: string }

export async function applyInstall(plan: InstallPlan, onStage: (s: string) => void = () => {}): Promise<ApplyResult> {
  if (plan.platform !== "darwin") {
    return { ok: false, reason: "unsupported_platform", message: "Installing on Linux isn't supported yet; `--plan` shows the units to write by hand." }
  }
  onStage("checking that this spinuptui has Scheduler")
  if (!(await binHasScheduler(plan))) return NO_SCHEDULER
  const domain = `gui/${process.getuid?.() ?? 501}`
  mkdirSync(dirname(plan.unitPath), { recursive: true })
  mkdirSync(schedulerStateDir(), { recursive: true })
  onStage(`writing ${plan.unitPath}`)
  writeFileSync(plan.unitPath, plan.unitText, { mode: 0o644 })
  await launchctl("bootout", `${domain}/${plan.label}`)
  const since = Date.now()
  onStage("loading it with launchctl")
  const boot = await launchctl("bootstrap", domain, plan.unitPath)
  if (boot.code !== 0) return { ok: false, reason: "launchctl_failed", message: `launchctl bootstrap failed: ${boot.out}`, unitPath: plan.unitPath }
  await saveConfig({
    scheduler: { ...(loadConfig().scheduler ?? {}), dispatcher: { label: plan.label, unitPath: plan.unitPath, bin: plan.bin, installedAt: new Date().toISOString() } },
  })

  // Proof: a tick that ran under launchd itself, not from this shell.
  onStage("waiting for the dispatcher's first tick")
  let kicked = false
  for (let waited = 0; waited < 60_000; waited += 1000) {
    const last = readLastTick()
    if (last && last.via === "dispatcher" && Date.parse(last.at) >= since) {
      return { ok: true, label: plan.label, unitPath: plan.unitPath, tickAt: last.at, notes: plan.notes }
    }
    if (!kicked && waited >= 15_000) {
      kicked = true
      await launchctl("kickstart", `${domain}/${plan.label}`)
    }
    await Bun.sleep(1000)
  }
  return {
    ok: false,
    reason: "no_tick",
    message: "The dispatcher is installed, but no tick arrived from it within 60 seconds.",
    remedy: `Check ${join(schedulerStateDir(), "launchd.log")} and \`launchctl print ${domain}/${plan.label}\`.`,
    unitPath: plan.unitPath,
  }
}

export interface UninstallPlan {
  label: string
  unitPath: string
  installed: boolean
  commands: string[]
}

export function planUninstall(): UninstallPlan {
  const d = loadConfig().scheduler?.dispatcher
  const label = d?.label ?? schedulerLabel()
  const unitPath = d?.unitPath ?? join(homedir(), "Library/LaunchAgents", `${label}.plist`)
  const domain = `gui/${process.getuid?.() ?? 501}`
  return {
    label,
    unitPath,
    installed: !!d || existsSync(unitPath),
    commands: [`launchctl bootout ${domain}/${label}`, `delete ${unitPath}`, "clear scheduler.dispatcher in config.json (sources, jobs and reports are kept)"],
  }
}

export async function applyUninstall(plan: UninstallPlan): Promise<{ ok: true; removed: string }> {
  if (process.platform === "darwin") await launchctl("bootout", `gui/${process.getuid?.() ?? 501}/${plan.label}`)
  if (existsSync(plan.unitPath)) unlinkSync(plan.unitPath)
  const s = loadConfig().scheduler
  if (s?.dispatcher) {
    const { dispatcher: _gone, ...rest } = s
    await saveConfig({ scheduler: rest })
  }
  return { ok: true, removed: plan.unitPath }
}

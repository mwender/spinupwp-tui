// `spinuptui scheduler …` — the CLI over Scheduler (lib/schedule*.ts,
// lib/scheduler*.ts). Headless like every module command: --json prints one
// result object on stdout, progress goes to stderr, failures use the
// { ok: false, reason, message, remedy? } shape and exit 1.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { loadConfig, saveConfig } from "../config.ts"
import { schedulerModule } from "../modules/scheduler.ts"
import { fmt, nextRunText } from "./schedule.ts"
import {
  defaultSourceName,
  expandHome,
  findSource,
  ID_RE,
  jobsDir,
  KINDS,
  listSources,
  loadJobs,
  loadState,
  LOCAL_SOURCE,
  parseJobText,
  renderJob,
  validateJob,
  type Source,
} from "./schedulerJobs.ts"
import { applyInstall, applyUninstall, binHasScheduler, NO_SCHEDULER, planInstall, planUninstall } from "./schedulerInstall.ts"
import { git, gitPull, tick } from "./schedulerTick.ts"

const VALUE_FLAGS = new Set([
  "--source",
  "--kind",
  "--when",
  "--every",
  "--expires",
  "--created-by",
  "--workdir",
  "--timeout",
  "--notify",
  "--to",
  "--agent",
  "--allow",
  "--add-dirs",
  "--model",
  "--sandbox",
  "--body-file",
  "--prompt-file",
  "--bin",
])

// Header keys `add` writes from flags, in file order.
const OPTIONAL_KEYS: [string, string][] = [
  ["workdir", "--workdir"],
  ["timeout", "--timeout"],
  ["notify", "--notify"],
  ["to", "--to"],
  ["agent", "--agent"],
  ["allow", "--allow"],
  ["add_dirs", "--add-dirs"],
  ["model", "--model"],
  ["sandbox", "--sandbox"],
]

const USAGE = `Usage:
  spinuptui scheduler status [--json]
  spinuptui scheduler list [--source <name>] [--json]
  spinuptui scheduler show <id> [--source <name>]
  spinuptui scheduler add <id> --kind ${KINDS.join("|")} (--when "YYYY-MM-DD HH:MM" | --when now | --every <schedule>)
                          --expires YYYY-MM-DD --created-by <who> [--source <name>] [options]
                          [--body-file <path> | -- <body>]   (else stdin)
  spinuptui scheduler cancel <id> [--source <name>]
  spinuptui scheduler run <id> [--source <name>]     run it now, on this machine
  spinuptui scheduler validate [--source <name>]
  spinuptui scheduler source add <name> <path> [--default] | source remove <name>
  spinuptui scheduler tick [--here]
  spinuptui scheduler install | uninstall --plan | --apply [--bin <path>]

Schedules: --every 30m | 6h | "daily 08:00" | "weekdays 08:00" | "mon,thu 08:00" (station local time).
Add options: --workdir <dir> --timeout <min> --notify beacon|none --to <channel>
  agent jobs: --agent claude|codex --allow <tools> --add-dirs <dirs> --model <m> --sandbox <mode>
The body is a spinuptui command line (kind spinuptui), a bash script (script), or a prompt
(agent). Write it for a reader with no context, and keep secrets out of it: reports are
written to the source, and a git source commits them.`

interface Parsed {
  positionals: string[]
  flags: Map<string, string>
  rest: string[] | null
}

function parse(list: string[]): Parsed {
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
  return { positionals, flags, rest: dash === -1 ? null : list.slice(dash + 1) }
}

function fail(json: boolean, reason: string, message: string, remedy?: string): number {
  if (json) console.log(JSON.stringify({ ok: false, reason, message, ...(remedy ? { remedy } : {}) }))
  else {
    console.error(message)
    if (remedy) console.error(remedy)
  }
  return 1
}

const say = (line: string) => process.stderr.write(`→ ${line}\n`)

// Re-quote argv so splitArgs() gives the same argv back: `add … -- ssh-exec x -- 'curl -sI …'`
// arrives with the shell's quotes already removed.
export function quoteArg(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`
}

export async function runScheduler(argv: string[]): Promise<number> {
  const p = parse(argv)
  const json = p.flags.has("--json")
  for (const f of VALUE_FLAGS) {
    if (p.flags.has(f) && (!p.flags.get(f) || p.flags.get(f)!.startsWith("--"))) return fail(json, "usage", `${f} needs a value.\n${USAGE}`)
  }
  const [sub, ...pos] = p.positionals
  switch (sub) {
    case "status":
      return status(json)
    case "list":
      return list(p, json)
    case "show":
      return show(pos, p)
    case "add":
      return add(pos, p, json)
    case "cancel":
      return cancel(pos, p, json)
    case "run":
      return run(pos, p, json)
    case "validate":
      return validate(p, json)
    case "source":
      return source(pos, p, json)
    case "tick":
      return doTick(p, json)
    case "install":
      return install(p, json)
    case "uninstall":
      return uninstall(p, json)
  }
  return fail(json, "usage", USAGE)
}

function sourceOrFail(p: Parsed, json: boolean): Source | number {
  const name = p.flags.get("--source") ?? null
  const s = findSource(loadConfig(), name)
  if (s) return s
  const names = listSources(loadConfig()).map((x) => x.name)
  return fail(json, "unknown_source", `No Scheduler source named "${name ?? defaultSourceName(loadConfig())}" (have: ${names.join(", ")}).`, "Add one with `spinuptui scheduler source add <name> <path>`.")
}

async function status(json: boolean): Promise<number> {
  const s = await schedulerModule.status()
  if (json) console.log(JSON.stringify({ ok: true, ...s }))
  else {
    console.log(`Scheduler: ${s.state} — ${s.summary}`)
    for (const c of s.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
    if (s.remedy) console.log(`  → ${s.remedy}`)
  }
  return 0
}

async function list(p: Parsed, json: boolean): Promise<number> {
  const cfg = loadConfig()
  const only = p.flags.get("--source")
  const sources = listSources(cfg).filter((s) => !only || s.name === only)
  if (only && sources.length === 0) return fail(json, "unknown_source", `No Scheduler source named "${only}".`)
  const now = new Date()
  const jobs: Record<string, unknown>[] = []
  for (const s of sources) {
    if (!existsSync(s.path)) continue
    if (s.git && !p.flags.has("--no-pull")) {
      const e = await gitPull(s.path)
      if (e) process.stderr.write(`Warning: ${s.name}: ${e}\n`)
    }
    for (const j of loadJobs(s)) {
      const h = j.header
      if (j.problems.length) {
        jobs.push({ source: s.name, id: h.id ?? j.name, invalid: j.problems })
        continue
      }
      const st = loadState(s, h.id!)
      jobs.push({
        source: s.name,
        id: h.id,
        kind: h.kind === "agent" ? `agent/${h.agent || "claude"}` : h.kind,
        schedule: h.when ?? `every ${h.every}`,
        expires: h.expires,
        runs: st.runs ?? 0,
        last: st.last_status ?? "-",
        next: nextRunText(h, st, now),
        ...(st.last_report ? { lastReport: st.last_report } : {}),
      })
    }
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, jobs }))
    return 0
  }
  if (jobs.length === 0) {
    console.log(`No jobs. Queue one with \`spinuptui scheduler add\` (see --help).`)
    return 0
  }
  const rows = [["SOURCE", "ID", "KIND", "SCHEDULE", "EXPIRES", "RUNS", "LAST", "NEXT"]]
  for (const j of jobs) {
    if (j.invalid) rows.push([String(j.source), String(j.id), "?", `INVALID: ${(j.invalid as string[]).join("; ")}`.slice(0, 70), "", "", "", ""])
    else rows.push([j.source, j.id, j.kind, j.schedule, j.expires, j.runs, j.last, j.next].map(String))
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd())
  return 0
}

async function show(pos: string[], p: Parsed): Promise<number> {
  const id = pos[0]
  if (!id) return fail(false, "usage", USAGE)
  const s = sourceOrFail(p, false)
  if (typeof s === "number") return s
  if (s.git && !p.flags.has("--no-pull")) await gitPull(s.path)
  const path = join(jobsDir(s), `${id}.md`)
  console.log(existsSync(path) ? readFileSync(path, "utf8") : `(no jobs/${id}.md in ${s.name} — cancelled or never added)`)
  const st = loadState(s, id)
  if (st.last_report && existsSync(join(s.path, st.last_report))) {
    console.log(`=== latest report: ${s.name}/${st.last_report}\n`)
    console.log(readFileSync(join(s.path, st.last_report), "utf8"))
  }
  return 0
}

async function readBody(p: Parsed): Promise<string | null> {
  const file = p.flags.get("--body-file") ?? p.flags.get("--prompt-file")
  if (file) return readFileSync(expandHome(file), "utf8")
  // A spinuptui body is an argv, so keep each argument's boundaries; a script
  // or prompt is text, usually passed as one quoted argument.
  if (p.rest !== null) return p.flags.get("--kind") === "spinuptui" ? p.rest.map(quoteArg).join(" ") : p.rest.join(" ")
  if (!process.stdin.isTTY) return Bun.stdin.text()
  return null
}

async function add(pos: string[], p: Parsed, json: boolean): Promise<number> {
  const id = pos[0]
  const f = p.flags
  if (!id) return fail(json, "usage", USAGE)
  if (!ID_RE.test(id)) return fail(json, "usage", "Job ids are lowercase letters, digits and hyphens (2–80 characters).")
  for (const req of ["--kind", "--expires", "--created-by"]) if (!f.has(req)) return fail(json, "usage", `${req} is required.\n${USAGE}`)
  if (f.has("--when") === f.has("--every")) return fail(json, "usage", "Give exactly one of --when or --every.")
  const s = sourceOrFail(p, json)
  if (typeof s === "number") return s
  const body = await readBody(p)
  if (body === null || !body.trim()) return fail(json, "usage", "No body: pass --body-file <path>, `-- <command…>`, or pipe it on stdin.")

  if (s.git && !f.has("--no-push")) {
    const e = await gitPull(s.path)
    if (e) return fail(json, "git_failed", `${s.name}: ${e}`)
  }
  const path = join(jobsDir(s), `${id}.md`)
  if (existsSync(path) && !f.has("--replace")) return fail(json, "exists", `${s.name}/jobs/${id}.md already exists.`, "Pass --replace, or pick another id.")
  const now = new Date()
  const header: [string, string][] = [
    ["id", id],
    ["kind", f.get("--kind")!],
  ]
  if (f.has("--when")) header.push(["when", f.get("--when") === "now" ? fmt(now) : f.get("--when")!])
  else header.push(["every", f.get("--every")!])
  header.push(["expires", f.get("--expires")!], ["created", fmt(now)], ["created_by", f.get("--created-by")!])
  for (const [key, flag] of OPTIONAL_KEYS) if (f.get(flag)) header.push([key, f.get(flag)!])
  const text = renderJob(header, body)
  const parsed = parseJobText(text)
  const problems = validateJob(parsed.header, parsed.body, `${id}.md`)
  if (problems.length) return fail(json, "invalid_job", `Not added: ${problems.join("; ")}`)

  mkdirSync(jobsDir(s), { recursive: true })
  writeFileSync(`${path}.tmp`, text)
  renameSync(`${path}.tmp`, path)
  let pushed: boolean | null = null
  if (s.git && !f.has("--no-push")) {
    await git(s.path, "add", "--", path)
    await git(s.path, "commit", "--quiet", "-m", `job: ${f.has("--replace") ? "replace" : "add"} ${id} (${f.get("--created-by")})`)
    const r = await git(s.path, "push", "--quiet")
    if (r.code !== 0) return fail(json, "push_failed", `Committed ${s.name}/jobs/${id}.md, but the push failed, so the station won't see it until it's pushed:\n${r.out}`)
    pushed = true
  }
  const result = { ok: true, source: s.name, id, path, pushed }
  if (json) console.log(JSON.stringify(result))
  else console.log(`Queued ${s.name}/jobs/${id}.md${pushed ? " and pushed it" : ""}. The station runs it within 5 minutes of it falling due.`)
  return 0
}

async function cancel(pos: string[], p: Parsed, json: boolean): Promise<number> {
  const id = pos[0]
  if (!id) return fail(json, "usage", USAGE)
  const s = sourceOrFail(p, json)
  if (typeof s === "number") return s
  if (s.git) await gitPull(s.path)
  const path = join(jobsDir(s), `${id}.md`)
  if (!existsSync(path)) return fail(json, "unknown_job", `No ${s.name}/jobs/${id}.md.`)
  let pushed: boolean | null = null
  if (s.git) {
    await git(s.path, "rm", "--quiet", "--", path)
    await git(s.path, "commit", "--quiet", "-m", `job: cancel ${id}`)
    pushed = (await git(s.path, "push", "--quiet")).code === 0
  } else unlinkSync(path)
  if (json) console.log(JSON.stringify({ ok: true, source: s.name, id, pushed }))
  else console.log(`Cancelled ${s.name}/${id}${pushed === false ? " (the push failed; push it by hand)" : ""}. Its reports stay in runs/.`)
  return 0
}

async function run(pos: string[], p: Parsed, json: boolean): Promise<number> {
  const id = pos[0]
  if (!id) return fail(json, "usage", USAGE)
  const s = sourceOrFail(p, json)
  if (typeof s === "number") return s
  if (!loadJobs(s).some((j) => j.header.id === id)) return fail(json, "unknown_job", `No job "${id}" in source ${s.name}.`)
  const r = await tick({ via: "manual", only: { source: s.name, id } })
  if (json) console.log(JSON.stringify(r))
  else if ("skipped" in r) console.error(r.message)
  else {
    for (const x of r.ran) console.log(`${x.source}/${x.id}: ${x.status}${x.report ? ` — ${x.report}` : ""}${x.notified && x.notified !== "sent" ? ` (not paged: ${x.notified})` : ""}`)
    for (const e of r.errors) console.error(`Warning: ${e}`)
  }
  if ("skipped" in r) return 1
  return r.ran.some((x) => x.status !== "ok") ? 1 : 0
}

async function validate(p: Parsed, json: boolean): Promise<number> {
  const only = p.flags.get("--source")
  const bad: { source: string; file: string; problems: string[] }[] = []
  for (const s of listSources(loadConfig())) {
    if ((only && s.name !== only) || !existsSync(s.path)) continue
    for (const j of loadJobs(s)) if (j.problems.length) bad.push({ source: s.name, file: j.name, problems: j.problems })
  }
  if (json) console.log(JSON.stringify({ ok: bad.length === 0, invalid: bad }))
  else {
    for (const b of bad) console.log(`${b.source}/jobs/${b.file}: ${b.problems.join("; ")}`)
    console.log(bad.length ? `${bad.length} invalid job file(s)` : "all jobs valid")
  }
  return bad.length ? 1 : 0
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

async function source(pos: string[], p: Parsed, json: boolean): Promise<number> {
  const [action, name, path] = pos
  const stored = loadConfig().scheduler ?? {}
  if (action === "add") {
    if (!name || !path) return fail(json, "usage", "Usage: spinuptui scheduler source add <name> <path> [--default]")
    if (!NAME_RE.test(name) || name === LOCAL_SOURCE) return fail(json, "usage", `"${name}" can't be a source name (lowercase letters, digits and dashes; "local" is built in).`)
    const abs = resolve(expandHome(path))
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return fail(json, "not_a_directory", `${abs} is not a directory.`)
    const git = existsSync(join(abs, ".git"))
    // The source's lock lives in .state/; keep it out of the repository without
    // committing anything to it (info/exclude is local to this clone).
    if (git && existsSync(join(abs, ".git", "info"))) {
      const exclude = join(abs, ".git", "info", "exclude")
      const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
      if (!current.split("\n").some((l) => l.trim() === ".state/" || l.trim() === "/.state/")) {
        writeFileSync(exclude, current + (current && !current.endsWith("\n") ? "\n" : "") + "# SpinupTUI Scheduler's lock\n/.state/\n")
      }
    }
    await saveConfig({
      scheduler: { ...stored, sources: { ...(stored.sources ?? {}), [name]: { path: abs } }, ...(p.flags.has("--default") ? { defaultSource: name } : {}) },
    })
    const jobs = existsSync(join(abs, "jobs")) ? loadJobs({ name, path: abs, git }).length : 0
    if (json) console.log(JSON.stringify({ ok: true, source: name, path: abs, git, jobs, default: p.flags.has("--default") }))
    else console.log(`Added source "${name}" (${abs}${git ? ", git: pulled before each tick, runs/ pushed after" : ""}) with ${jobs} job file(s)${p.flags.has("--default") ? "; it's now the default" : ""}.`)
    return 0
  }
  if (action === "remove") {
    if (!name || !stored.sources?.[name]) return fail(json, "unknown_source", `No Scheduler source named "${name ?? ""}".`)
    const { [name]: _gone, ...sources } = stored.sources
    const next = { ...stored, sources }
    if (next.defaultSource === name) delete next.defaultSource
    await saveConfig({ scheduler: next })
    if (json) console.log(JSON.stringify({ ok: true, removed: name }))
    else console.log(`Removed source "${name}". Its directory and files are untouched.`)
    return 0
  }
  return fail(json, "usage", "Usage: spinuptui scheduler source add <name> <path> [--default] | source remove <name>")
}

async function doTick(p: Parsed, json: boolean): Promise<number> {
  const dispatcher = process.env.SPINUPTUI_SCHEDULER_DISPATCHER === "1"
  if (!dispatcher && !p.flags.has("--here")) {
    return fail(
      json,
      "not_dispatcher",
      "`scheduler tick` runs due jobs on THIS machine. The installed dispatcher sets SPINUPTUI_SCHEDULER_DISPATCHER=1; pass --here to run one anyway.",
    )
  }
  const r = await tick({ via: dispatcher ? "dispatcher" : "manual" })
  // Under launchd stdout is launchd.log, kept for crashes: the tick's record is
  // already in last-tick.json and tick.log.
  if (dispatcher && !json) return 0
  if (json) console.log(JSON.stringify(r))
  else if ("skipped" in r) console.error(r.message)
  else {
    if (r.ran.length === 0) console.log("Nothing due.")
    for (const x of r.ran) console.log(`${x.source}/${x.id}: ${x.status}${x.report ? ` — ${x.report}` : ""}`)
    for (const e of r.errors) console.error(`Warning: ${e}`)
  }
  return 0
}

async function install(p: Parsed, json: boolean): Promise<number> {
  const apply = p.flags.has("--apply")
  if (apply === p.flags.has("--plan")) return fail(json, "usage", "Pass --plan to see what would be installed, or --apply to install it.")
  const plan = planInstall({ bin: p.flags.get("--bin") ?? null })
  if (!plan.ok) return fail(json, plan.reason, plan.message, plan.remedy)
  // Refuse at --plan too, so a plan that can't work is never shown as one.
  if (!(await binHasScheduler(plan))) return fail(json, NO_SCHEDULER.reason, NO_SCHEDULER.message, NO_SCHEDULER.remedy)
  if (!apply) {
    if (json) console.log(JSON.stringify(plan))
    else {
      console.log(`Would install Scheduler's dispatcher (${plan.label}), running every 5 minutes and at login:\n`)
      console.log(`  ${plan.programArguments.join(" ")}\n`)
      console.log(`Unit: ${plan.unitPath}`)
      for (const u of plan.extraUnits ?? []) console.log(`Unit: ${u.path}`)
      console.log(`PATH: ${plan.env.PATH}\n`)
      console.log("Steps:")
      for (const c of plan.commands) console.log(`  · ${c}`)
      for (const n of plan.notes) console.log(`Note: ${n}`)
      console.log(`\nRun with --apply to install it.`)
    }
    return 0
  }
  const r = await applyInstall(plan, say)
  if (!r.ok) return fail(json, r.reason, r.message, r.remedy)
  if (json) console.log(JSON.stringify(r))
  else {
    console.log(`Installed ${r.label}. Its first tick ran under launchd at ${new Date(r.tickAt).toLocaleTimeString()}.`)
    for (const n of r.notes) console.log(`Note: ${n}`)
  }
  return 0
}

async function uninstall(p: Parsed, json: boolean): Promise<number> {
  const apply = p.flags.has("--apply")
  if (apply === p.flags.has("--plan")) return fail(json, "usage", "Pass --plan to see what would be removed, or --apply to remove it.")
  const plan = planUninstall()
  if (!apply) {
    if (json) console.log(JSON.stringify({ ok: true, ...plan }))
    else if (!plan.installed) console.log("Scheduler's dispatcher isn't installed; nothing to remove.")
    else {
      console.log(`Would remove Scheduler's dispatcher (${plan.label}):`)
      for (const c of plan.commands) console.log(`  · ${c}`)
    }
    return 0
  }
  const r = await applyUninstall(plan)
  if (json) console.log(JSON.stringify(r))
  else console.log(`Removed ${plan.label}. Jobs and reports are still in place; \`install --apply\` brings the dispatcher back.`)
  return 0
}

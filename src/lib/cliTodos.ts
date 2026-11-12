// `spinuptui todos`: the to-do list from the command line. Text by
// default, JSON with --json. Every change is an appended event, signed with this
// machine's name, and committed with Sentinel's folder when that's in git.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { loadConfig } from "../config.ts"
import { effectiveState, extractTodos, fillPlaceholders, TODO_KINDS, todoNote, planEntries, readLedger, sortById, withLedger, type Todo } from "./todos.ts"
import { changeTodo, commitLedger, operator, stateLabel, type TodoAction } from "./todoActions.ts"
import { sentinelSettings } from "./sentinelState.ts"

const USAGE = `Usage:
  spinuptui todos list [--state open|done|wontfix|snoozed|all] [--kind <kind>]
                           [--site <domain>] [--server <host>] [--json]
  spinuptui todos show <id> [--json]
  spinuptui todos done <id> [comment]
  spinuptui todos wontfix <id> <reason>     Sentinel reads the reason
  spinuptui todos snooze <id> --until YYYY-MM-DD [comment]
  spinuptui todos comment <id> <text>
  spinuptui todos reopen <id> [comment]
  spinuptui todos import <report> [--force]
                           record the to-dos block left in a report`

const VALUE_FLAGS = new Set(["--state", "--kind", "--site", "--server", "--until"])

function parse(list: string[]) {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (!a.startsWith("--")) positionals.push(a)
    else if (VALUE_FLAGS.has(a)) flags.set(a, list[++i] ?? "")
    else flags.set(a, "")
  }
  return { positionals, flags }
}

function fail(json: boolean, reason: string, message: string): number {
  if (json) console.log(JSON.stringify({ ok: false, reason, message }))
  else console.error(message)
  return 1
}

async function commit(message: string): Promise<void> {
  await commitLedger(message)
}

export function describeTodo(f: Todo, now = new Date()): string {
  const label = stateLabel(effectiveState(f, now), f.until)
  return `${f.id.padEnd(6)} ${label.padEnd(9)} ${f.kind.padEnd(10)} ${f.scope}\n       ${f.title}`
}

export async function runTodos(argv: string[]): Promise<number> {
  const p = parse(argv)
  const json = p.flags.has("--json")
  const [sub, id, ...rest] = p.positionals
  const now = new Date()
  switch (sub) {
    case "list": {
      const state = p.flags.get("--state") ?? "open"
      const kind = p.flags.get("--kind")
      if (kind && !TODO_KINDS.includes(kind as never)) return fail(json, "usage", `--kind is one of ${TODO_KINDS.join(", ")}.`)
      const site = p.flags.get("--site")?.toLowerCase()
      const server = p.flags.get("--server")?.toLowerCase()
      const { items, skipped } = readLedger()
      const rows = [...items.values()]
        .filter((f) => state === "all" || effectiveState(f, now) === state)
        .filter((f) => !kind || f.kind === kind)
        .filter((f) => !site || f.scope === `site:${site}`)
        .filter((f) => !server || f.scope === `server:${server}`)
        .sort(sortById)
      if (json) console.log(JSON.stringify({ ok: true, todos: rows.map(({ history: _h, ...f }) => ({ ...f, state: effectiveState({ ...f, history: [] }, now) })), skipped }))
      else {
        console.log(rows.length ? rows.map((f) => describeTodo(f, now)).join("\n") : `No ${state === "all" ? "" : `${state} `}to-dos.`)
        if (skipped) console.error(`${skipped} line(s) of the ledger didn't parse and were skipped.`)
      }
      return 0
    }
    case "show": {
      const f = id ? readLedger().items.get(id.toUpperCase()) : undefined
      if (!f) return fail(json, "unknown_todo", `No to-do "${id ?? ""}".`)
      if (json) console.log(JSON.stringify({ ok: true, followup: { ...f, state: effectiveState(f, now) } }))
      else {
        console.log(describeTodo(f, now))
        if (f.detail) console.log(`\n${f.detail}`)
        if (f.fix) console.log(`\nFix: ${f.fix.template} ${JSON.stringify(f.fix.params)}`)
        if (f.reports.length) console.log(`\nReports:\n${f.reports.map((r) => `  ${r}`).join("\n")}`)
        console.log(`\nHistory:\n${f.history.map((e) => `  ${e.at.slice(0, 16).replace("T", " ")}  ${e.by}  ${e.event}${"text" in e && e.text ? `: ${e.text}` : ""}`).join("\n")}`)
      }
      return 0
    }
    case "done":
    case "wontfix":
    case "snooze":
    case "comment":
    case "reopen":
      return change(sub, id, rest.join(" ").trim(), p.flags, json, now)
    case "import":
      return importReport(id, p.flags.has("--force"), json, now)
  }
  return fail(json, "usage", USAGE)
}

async function change(sub: string, rawId: string | undefined, text: string, flags: Map<string, string>, json: boolean, now: Date): Promise<number> {
  if (!rawId) return fail(json, "usage", USAGE)
  const action = sub as TodoAction
  const r = changeTodo(rawId, { action, text, until: flags.get("--until"), by: operator(), now })
  if (!r.ok) return fail(json, r.reason, r.message)
  const id = r.event.id
  await commit(`todos: ${id} ${sub}`)
  const after = readLedger().items.get(id)!
  if (json) console.log(JSON.stringify({ ok: true, followup: { ...after, state: effectiveState(after, now) } }))
  else console.log(sub === "comment" ? `Comment added to ${id}.` : `${id} is now ${stateLabel(effectiveState(after, now), after.until)}.`)
  return 0
}

// A report whose to-dos block didn't parse keeps it, so it can be fixed by
// hand and imported. Importing strips the block and fills the [new-n] tags, as the
// worker would have.
async function importReport(arg: string | undefined, force: boolean, json: boolean, now: Date): Promise<number> {
  if (!arg) return fail(json, "usage", USAGE)
  const workspace = sentinelSettings(loadConfig()).workspace
  const abs = isAbsolute(arg) ? arg : existsSync(arg) ? join(process.cwd(), arg) : join(workspace, arg)
  if (!existsSync(abs)) return fail(json, "no_report", `No report at ${abs}.`)
  const rel = abs.startsWith(workspace + "/") ? relative(workspace, abs) : abs
  const ex = extractTodos(readFileSync(abs, "utf8"))
  if (ex.error) return fail(json, "bad_block", `${ex.error}. Fix it in ${abs} and import again.`)
  if (!ex.entries) return fail(json, "no_block", `${rel} has no to-dos block.`)
  const r = withLedger<{ ok: true; note: string; created: string[] } | { ok: false; message: string }>(({ events, items }) => {
    if (!force && events.some((e) => e.event === "created" && e.report === rel)) return { events: [], result: { ok: false, message: `${rel} was already imported. Use --force to import it again.` } }
    const planned = planEntries(ex.entries!, items, rel, now.toISOString())
    writeFileSync(abs, fillPlaceholders(ex.text, planned.placeholders))
    return { events: planned.events, result: { ok: true, note: todoNote(planned), created: planned.created } }
  })
  if (!r.ok) return fail(json, "already_imported", r.message)
  await commit(`todos: import ${rel}`)
  if (json) console.log(JSON.stringify({ ok: true, report: rel, created: r.created, note: r.note }))
  else console.log(r.note || "The block was empty: nothing to record.")
  return 0
}

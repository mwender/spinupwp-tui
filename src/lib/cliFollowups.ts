// `spinuptui followups`: the follow-up ledger from the command line. Text by
// default, JSON with --json. Every change is an appended event, signed with this
// machine's name, and committed with Sentinel's folder when that's in git.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { loadConfig } from "../config.ts"
import { moduleWorkDir } from "../modules/contract.ts"
import { effectiveState, extractFollowups, fillPlaceholders, FOLLOWUP_KINDS, followupNote, planEntries, readLedger, sortById, withLedger, type Followup, type FollowupEvent } from "./followups.ts"
import { commitAndPush, stationName } from "./schedulerGit.ts"
import { gitRootOf } from "./schedulerJobs.ts"
import { sentinelSettings } from "./sentinelState.ts"

const USAGE = `Usage:
  spinuptui followups list [--state open|done|wontfix|snoozed|all] [--kind <kind>]
                           [--site <domain>] [--server <host>] [--json]
  spinuptui followups show <id> [--json]
  spinuptui followups done <id> [comment]
  spinuptui followups wontfix <id> <reason>     Sentinel reads the reason
  spinuptui followups snooze <id> --until YYYY-MM-DD [comment]
  spinuptui followups comment <id> <text>
  spinuptui followups reopen <id> [comment]
  spinuptui followups import <report> [--force]
                           record the follow-ups block left in a report`

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

const operator = () => `operator@${stationName()}`

async function commit(message: string): Promise<void> {
  const work = moduleWorkDir("sentinel")
  const root = gitRootOf(work)
  if (!root) return
  const paths = ["followups.jsonl", ".gitattributes"].filter((f) => existsSync(join(work, f))).map((f) => relative(root, join(work, f)))
  if (paths.length) await commitAndPush(root, paths, message).catch(() => null)
}

export function describeFollowup(f: Followup, now = new Date()): string {
  const state = effectiveState(f, now)
  const label = state === "snoozed" && f.until ? `snoozed until ${f.until}` : state
  return `${f.id.padEnd(6)} ${label.padEnd(9)} ${f.kind.padEnd(10)} ${f.scope}\n       ${f.title}`
}

export async function runFollowups(argv: string[]): Promise<number> {
  const p = parse(argv)
  const json = p.flags.has("--json")
  const [sub, id, ...rest] = p.positionals
  const now = new Date()
  switch (sub) {
    case "list": {
      const state = p.flags.get("--state") ?? "open"
      const kind = p.flags.get("--kind")
      if (kind && !FOLLOWUP_KINDS.includes(kind as never)) return fail(json, "usage", `--kind is one of ${FOLLOWUP_KINDS.join(", ")}.`)
      const site = p.flags.get("--site")?.toLowerCase()
      const server = p.flags.get("--server")?.toLowerCase()
      const { items, skipped } = readLedger()
      const rows = [...items.values()]
        .filter((f) => state === "all" || effectiveState(f, now) === state)
        .filter((f) => !kind || f.kind === kind)
        .filter((f) => !site || f.scope === `site:${site}`)
        .filter((f) => !server || f.scope === `server:${server}`)
        .sort(sortById)
      if (json) console.log(JSON.stringify({ ok: true, followups: rows.map(({ history: _h, ...f }) => ({ ...f, state: effectiveState({ ...f, history: [] }, now) })), skipped }))
      else {
        console.log(rows.length ? rows.map((f) => describeFollowup(f, now)).join("\n") : `No ${state === "all" ? "" : `${state} `}follow-ups.`)
        if (skipped) console.error(`${skipped} line(s) of the ledger didn't parse and were skipped.`)
      }
      return 0
    }
    case "show": {
      const f = id ? readLedger().items.get(id.toUpperCase()) : undefined
      if (!f) return fail(json, "unknown_followup", `No follow-up "${id ?? ""}".`)
      if (json) console.log(JSON.stringify({ ok: true, followup: { ...f, state: effectiveState(f, now) } }))
      else {
        console.log(describeFollowup(f, now))
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
  const id = rawId.toUpperCase()
  if ((sub === "wontfix" || sub === "comment") && !text) return fail(json, "usage", sub === "wontfix" ? "A reason is required: Sentinel reads it before it recommends this again." : "Nothing to say.")
  const until = flags.get("--until") ?? ""
  if (sub === "snooze" && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until)))) return fail(json, "usage", "--until YYYY-MM-DD is required.")
  const base = { v: 1 as const, at: now.toISOString(), by: operator(), id }
  const result = withLedger<{ ok: true; f: Followup } | { ok: false; reason: string; message: string }>(({ items }) => {
    const f = items.get(id)
    if (!f) return { events: [], result: { ok: false, reason: "unknown_followup", message: `No follow-up "${rawId}".` } }
    const state = effectiveState(f, now)
    let e: FollowupEvent
    if (sub === "comment") e = { ...base, event: "comment", text }
    else if (sub === "snooze") e = { ...base, event: "snoozed", until, ...(text ? { text } : {}) }
    else if (sub === "reopen") {
      if (state === "open") return { events: [], result: { ok: false, reason: "already_open", message: `${id} is already open.` } }
      e = { ...base, event: "reopened", ...(text ? { text } : {}) }
    } else {
      if (state === sub) return { events: [], result: { ok: false, reason: `already_${sub}`, message: `${id} is already ${sub}.` } }
      e = { ...base, event: sub as "done" | "wontfix", ...(text ? { text } : {}) }
    }
    return { events: [e], result: { ok: true, f } }
  })
  if (!result.ok) return fail(json, result.reason, result.message)
  await commit(`followups: ${id} ${sub}`)
  const after = readLedger().items.get(id)!
  if (json) console.log(JSON.stringify({ ok: true, followup: { ...after, state: effectiveState(after, now) } }))
  else console.log(sub === "comment" ? `Comment added to ${id}.` : `${id} is now ${effectiveState(after, now)}${after.until && sub === "snooze" ? ` until ${after.until}` : ""}.`)
  return 0
}

// A report whose follow-ups block didn't parse keeps it, so it can be fixed by
// hand and imported. Importing strips the block and fills the [new-n] tags, as the
// worker would have.
async function importReport(arg: string | undefined, force: boolean, json: boolean, now: Date): Promise<number> {
  if (!arg) return fail(json, "usage", USAGE)
  const workspace = sentinelSettings(loadConfig()).workspace
  const abs = isAbsolute(arg) ? arg : existsSync(arg) ? join(process.cwd(), arg) : join(workspace, arg)
  if (!existsSync(abs)) return fail(json, "no_report", `No report at ${abs}.`)
  const rel = abs.startsWith(workspace + "/") ? relative(workspace, abs) : abs
  const ex = extractFollowups(readFileSync(abs, "utf8"))
  if (ex.error) return fail(json, "bad_block", `${ex.error}. Fix it in ${abs} and import again.`)
  if (!ex.entries) return fail(json, "no_block", `${rel} has no follow-ups block.`)
  const r = withLedger<{ ok: true; note: string; created: string[] } | { ok: false; message: string }>(({ events, items }) => {
    if (!force && events.some((e) => e.event === "created" && e.report === rel)) return { events: [], result: { ok: false, message: `${rel} was already imported. Use --force to import it again.` } }
    const planned = planEntries(ex.entries!, items, rel, now.toISOString())
    writeFileSync(abs, fillPlaceholders(ex.text, planned.placeholders))
    return { events: planned.events, result: { ok: true, note: followupNote(planned), created: planned.created } }
  })
  if (!r.ok) return fail(json, "already_imported", r.message)
  await commit(`followups: import ${rel}`)
  if (json) console.log(JSON.stringify({ ok: true, report: rel, created: r.created, note: r.note }))
  else console.log(r.note || "The block was empty: nothing to record.")
  return 0
}

// The operator's changes to a to-do: done, won't fix, snooze, comment, reopen.
// Shared by `spinuptui todos` and the Reports tab, so both write the same events
// and refuse the same things. Every change is one appended event, signed with
// this machine's name, then committed with Sentinel's folder when that's in git.

import { existsSync } from "node:fs"
import { join, relative } from "node:path"
import { moduleWorkDir } from "../modules/contract.ts"
import { effectiveState, withLedger, type Todo, type TodoEvent } from "./todos.ts"
import { commitAndPush, stationName } from "./schedulerGit.ts"
import { gitRootOf } from "./schedulerJobs.ts"

export type TodoAction = "done" | "wontfix" | "snooze" | "comment" | "reopen"
export const TODO_ACTIONS: readonly TodoAction[] = ["done", "wontfix", "snooze", "comment", "reopen"]

export const operator = () => `operator@${stationName()}`

export interface ChangeInput {
  action: TodoAction
  text: string
  until?: string // snooze only: YYYY-MM-DD
  by: string
  now: Date
}

export type Planned = { ok: true; event: TodoEvent } | { ok: false; reason: string; message: string }

export const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))

// What a change appends to one item, or why it's refused. No I/O, so Dev Mode can
// apply it to its in-memory list and the tests can call it directly.
export function planChange(f: Todo, input: ChangeInput): Planned {
  const { action, now } = input
  const text = input.text.trim()
  const base = { v: 1 as const, at: now.toISOString(), by: input.by, id: f.id }
  const state = effectiveState(f, now)
  switch (action) {
    case "comment":
      if (!text) return { ok: false, reason: "usage", message: "Nothing to say." }
      return { ok: true, event: { ...base, event: "comment", text } }
    case "wontfix":
      if (!text) return { ok: false, reason: "usage", message: "A reason is required: Sentinel reads it before it recommends this again." }
      if (state === "wontfix") return { ok: false, reason: "already_wontfix", message: `${f.id} is already won't fix.` }
      return { ok: true, event: { ...base, event: "wontfix", text } }
    case "snooze": {
      const until = input.until ?? ""
      if (!validDay(until)) return { ok: false, reason: "usage", message: "A date is required, as YYYY-MM-DD." }
      if (Date.parse(`${until}T23:59:59Z`) < now.getTime()) return { ok: false, reason: "usage", message: `${until} has already passed.` }
      return { ok: true, event: { ...base, event: "snoozed", until, ...(text ? { text } : {}) } }
    }
    case "reopen":
      if (state === "open") return { ok: false, reason: "already_open", message: `${f.id} is already open.` }
      return { ok: true, event: { ...base, event: "reopened", ...(text ? { text } : {}) } }
    case "done":
      if (state === "done") return { ok: false, reason: "already_done", message: `${f.id} is already done.` }
      return { ok: true, event: { ...base, event: "done", ...(text ? { text } : {}) } }
  }
}

export type Changed = { ok: true; event: TodoEvent } | { ok: false; reason: string; message: string }

// Plans and appends under the ledger's lock, so the item is read fresh: another
// machine's change merged in a moment ago is what it's judged against.
export function changeTodo(rawId: string, input: ChangeInput, path?: string): Changed {
  const id = rawId.toUpperCase()
  return withLedger<Changed>(({ items }) => {
    const f = items.get(id)
    if (!f) return { events: [], result: { ok: false, reason: "unknown_todo", message: `No to-do "${rawId}".` } }
    const p = planChange(f, input)
    return p.ok ? { events: [p.event], result: p } : { events: [], result: p }
  }, path)
}

// Commits the ledger with Sentinel's folder, when that folder is in git. Returns
// what went wrong, or null; a failed push is retried by the next commit.
export async function commitLedger(message: string): Promise<string | null> {
  const work = moduleWorkDir("sentinel")
  const root = gitRootOf(work)
  if (!root) return null
  const paths = ["todos.jsonl", ".gitattributes"].filter((f) => existsSync(join(work, f))).map((f) => relative(root, join(work, f)))
  if (!paths.length) return null
  return commitAndPush(root, paths, message).catch((e: Error) => e.message)
}

// "won't fix", not "wontfix", wherever a person reads it.
export const stateLabel = (state: string, until?: string) => (state === "wontfix" ? "won't fix" : state === "snoozed" && until ? `snoozed until ${until}` : state)

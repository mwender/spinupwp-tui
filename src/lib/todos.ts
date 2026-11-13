// The to-do list: every recommendation in a Sentinel report becomes an item
// with an ID, a kind, a scope and a state, so it isn't lost and Sentinel remembers
// what the operator decided (docs/2026-11-11_samurai-spec.md, "The to-do list").
//
// Stored as an append-only event log, one JSON event per line. The current state is
// a fold over the events. Writes only append, under a lock, and the home repository
// merges two machines' appends with git's union driver, so the log is never
// rewritten and never conflicts. Files are the source of truth here; a database
// would only ever be a rebuildable cache.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { moduleStateDir, moduleWorkDir } from "../modules/contract.ts"
import { tryLock, type HeldLock } from "./flock.ts"

export const TODO_KINDS = ["nginx", "monitoring", "plugin", "server", "sentinel", "decision", "watch", "note"] as const
export type TodoKind = (typeof TODO_KINDS)[number]
export type TodoState = "open" | "done" | "wontfix" | "snoozed"

// "site:example.com", "server:web1.example.com" or "fleet".
export type Scope = string

export interface Fix {
  template: string
  params: Record<string, unknown>
}

interface Base {
  v: 1
  at: string
  by: string // "sentinel", "operator@<machine>", or "claude@<machine>" (a Claude session)
  id: string
}

export type TodoEvent =
  | (Base & { event: "created"; kind: TodoKind; scope: Scope; title: string; detail?: string; fix?: Fix; report?: string })
  | (Base & { event: "report"; report: string; text?: string })
  | (Base & { event: "comment"; text: string })
  | (Base & { event: "done" | "wontfix" | "reopened" | "regressed"; text?: string; report?: string })
  | (Base & { event: "snoozed"; until: string; text?: string })
  | (Base & { event: "fix-applied" | "fix-rolled-back"; proposal: string; text?: string })

export interface Comment {
  at: string
  by: string
  text: string
}

export interface Todo {
  id: string
  kind: TodoKind
  scope: Scope
  title: string
  detail?: string
  fix?: Fix
  state: TodoState
  until?: string
  reports: string[]
  comments: Comment[]
  history: TodoEvent[]
  createdAt: string
  updatedAt: string
  changedAt: string // the last state change
}

export const ledgerPath = () => join(moduleWorkDir("sentinel"), "todos.jsonl")
const lockPath = () => join(moduleStateDir("sentinel"), "todos.lock")

// The line git's union merge driver needs, kept beside the log so it applies
// wherever Sentinel's folder lives.
const ATTRIBUTES = "todos.jsonl merge=union\n"

// ---- reading ----------------------------------------------------------------------------

export interface Ledger {
  items: Map<string, Todo>
  events: TodoEvent[]
  skipped: number // lines that didn't parse: a torn last line, or a bad merge
}

export function readLedger(path = ledgerPath()): Ledger {
  let text = ""
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { items: new Map(), events: [], skipped: 0 }
  }
  const events: TodoEvent[] = []
  let skipped = 0
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as TodoEvent
      if (e && typeof e.id === "string" && typeof e.at === "string" && typeof e.event === "string") events.push(e)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { items: fold(events), events, skipped }
}

// Timestamp order, not line order: a union merge can interleave two machines'
// lines. Ties keep file order, which is append order on one machine.
export function fold(events: TodoEvent[]): Map<string, Todo> {
  const sorted = events.map((e, n) => ({ e, n })).sort((a, b) => a.e.at.localeCompare(b.e.at) || a.n - b.n)
  const items = new Map<string, Todo>()
  for (const { e } of sorted) {
    if (e.event === "created") {
      if (items.has(e.id)) continue // a duplicate create, from a bad merge: the first wins
      items.set(e.id, {
        id: e.id,
        kind: e.kind,
        scope: e.scope,
        title: e.title,
        ...(e.detail ? { detail: e.detail } : {}),
        ...(e.fix ? { fix: e.fix } : {}),
        state: e.kind === "note" ? "done" : "open",
        reports: e.report ? [e.report] : [],
        comments: [],
        history: [e],
        createdAt: e.at,
        updatedAt: e.at,
        changedAt: e.at,
      })
      continue
    }
    const f = items.get(e.id)
    if (!f) continue // an event for an item this clone hasn't seen created
    f.history.push(e)
    f.updatedAt = e.at
    if ("report" in e && e.report && !f.reports.includes(e.report)) f.reports.push(e.report)
    if ("text" in e && e.text) f.comments.push({ at: e.at, by: e.by, text: e.text })
    const to = stateAfter(e)
    if (to) {
      f.state = to
      f.changedAt = e.at
      if (e.event === "snoozed") f.until = e.until
      else delete f.until
    }
  }
  return items
}

function stateAfter(e: TodoEvent): TodoState | null {
  switch (e.event) {
    case "done":
    case "fix-applied":
      return "done"
    case "wontfix":
      return "wontfix"
    case "snoozed":
      return "snoozed"
    case "reopened":
    case "regressed":
    case "fix-rolled-back":
      return "open"
    default:
      return null
  }
}

// A snooze that has run out reads as open again, without anyone writing an event.
export function effectiveState(f: Todo, now: Date): TodoState {
  if (f.state === "snoozed" && f.until && Date.parse(`${f.until}T23:59:59Z`) < now.getTime()) return "open"
  return f.state
}

export const isOpen = (f: Todo, now: Date) => effectiveState(f, now) === "open"

const idNumber = (id: string) => Number(/^T-(\d+)$/.exec(id)?.[1] ?? 0)

export function nextIdNumber(items: Map<string, Todo>): number {
  let max = 0
  for (const id of items.keys()) max = Math.max(max, idNumber(id))
  return max + 1
}

export const sortById = (a: Todo, b: Todo) => idNumber(a.id) - idNumber(b.id)

// ---- writing ----------------------------------------------------------------------------

function waitLock(path: string, ms = 10_000): HeldLock {
  const until = Date.now() + ms
  for (;;) {
    const l = tryLock(path)
    if (l) return l
    if (Date.now() > until) throw new Error("the to-do list is locked by another process")
    Bun.sleepSync(50)
  }
}

function prepare(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const attrs = join(dirname(path), ".gitattributes")
  const have = existsSync(attrs) ? readFileSync(attrs, "utf8") : ""
  if (!have.includes("todos.jsonl")) writeFileSync(attrs, have + (have && !have.endsWith("\n") ? "\n" : "") + ATTRIBUTES)
}

// Runs `fn` against the current ledger while holding the lock, and appends what it
// returns. Allocating IDs inside the lock is what keeps two writers from both
// creating T-42.
export function withLedger<T>(fn: (ledger: Ledger) => { events: TodoEvent[]; result: T }, path = ledgerPath()): T {
  prepare(path)
  const lock = waitLock(path === ledgerPath() ? lockPath() : `${path}.lock`)
  try {
    const ledger = readLedger(path)
    const { events, result } = fn(ledger)
    if (events.length) {
      // A torn last line from a crash would glue onto the next event.
      let text = ""
      try {
        text = readFileSync(path, "utf8")
      } catch {
        // a new ledger
      }
      const lead = text && !text.endsWith("\n") ? "\n" : ""
      appendFileSync(path, lead + events.map((e) => JSON.stringify(e)).join("\n") + "\n")
    }
    return result
  } finally {
    lock.release()
  }
}

export function appendEvents(events: TodoEvent[], path = ledgerPath()): void {
  withLedger(() => ({ events, result: undefined }), path)
}

// ---- the agent's block --------------------------------------------------------------------

// Templates Samurai will know. A fix naming anything else is dropped, and the item
// is created without one. Samurai validates again before it renders anything, so
// this is a first filter, not the boundary.
const SAFE_PATH = /^(=|~\*?|\^~)?\s*\S+$/
const FIX_RULES: Record<string, (p: Record<string, unknown>) => string | null> = {
  "deny-paths": (p) => paths(p.paths) ?? (p.status === undefined || [403, 404, 444].includes(p.status as number) ? null : "status must be 403, 404 or 444"),
  "gone-paths": (p) => paths(p.paths),
  "block-user-agent": (p) => (typeof p.pattern === "string" && p.pattern.length >= 3 && !/[\n;{}]/.test(p.pattern) ? null : "pattern must be a plain string"),
  "cloudflare-real-ip": () => null,
}

function paths(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 20) return "paths must be a list of 1 to 20 paths"
  for (const x of v) if (typeof x !== "string" || !SAFE_PATH.test(x.trim()) || /[\n;{}]/.test(x)) return `unsafe path: ${String(x).slice(0, 60)}`
  return null
}

export function validateFix(fix: unknown): { fix: Fix | null; why?: string } {
  if (!fix || typeof fix !== "object") return { fix: null, why: "not an object" }
  const f = fix as { template?: unknown; params?: unknown }
  const rule = typeof f.template === "string" ? FIX_RULES[f.template] : undefined
  if (!rule) return { fix: null, why: `no template named ${String(f.template)}` }
  const params = f.params && typeof f.params === "object" && !Array.isArray(f.params) ? (f.params as Record<string, unknown>) : {}
  const why = rule(params)
  return why ? { fix: null, why } : { fix: { template: f.template as string, params } }
}

const SCOPE_RE = /^(fleet|site:[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+|server:[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+)$/i

export interface BlockEntry {
  ref: string
  [k: string]: unknown
}

export interface Extracted {
  text: string // the answer with the block removed
  entries: BlockEntry[] | null
  error?: string // the block was there but didn't parse
}

// The last ```todos fence in the answer. No block is fine: not every report
// has to-dos, and older agents don't write one.
export function extractTodos(text: string): Extracted {
  const re = /^```todos[ \t]*\n([\s\S]*?)^```[ \t]*$/gm
  const m = [...text.matchAll(re)].pop()
  if (!m) return { text, entries: null }
  const stripped = (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"
  try {
    const parsed = JSON.parse(m[1]!) as unknown
    if (!Array.isArray(parsed)) return { text, entries: null, error: "the to-dos block isn't a JSON list" }
    const entries = parsed.filter((e): e is BlockEntry => !!e && typeof e === "object" && typeof (e as BlockEntry).ref === "string")
    return { text: stripped, entries }
  } catch (err) {
    return { text, entries: null, error: `the to-dos block isn't valid JSON (${(err as Error).message})` }
  }
}

export interface Applied {
  events: TodoEvent[]
  created: string[]
  stillOpen: string[]
  regressed: { id: string; title: string; text: string }[]
  warnings: string[]
  placeholders: Map<string, string> // "new-1" → "T-43"
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "")

// Turns the agent's entries into events. The agent may create items, attach a
// report to one, and reopen a done item whose problem is back. It never closes,
// won't-fixes or snoozes anything: that's the operator's call.
export function planEntries(entries: BlockEntry[], items: Map<string, Todo>, report: string, at: string): Applied {
  const out: Applied = { events: [], created: [], stillOpen: [], regressed: [], warnings: [], placeholders: new Map() }
  let n = nextIdNumber(items)
  const base = { v: 1 as const, at, by: "sentinel" }
  for (const e of entries) {
    const ref = e.ref.trim()
    if (/^new(-\w+)?$/i.test(ref)) {
      const kind = str(e.kind, 20) as TodoKind
      const scope = str(e.scope, 120)
      const title = str(e.title, 200)
      if (!TODO_KINDS.includes(kind)) {
        out.warnings.push(`skipped "${title || ref}": unknown kind ${String(e.kind)}`)
        continue
      }
      if (!SCOPE_RE.test(scope)) {
        out.warnings.push(`skipped "${title || ref}": bad scope ${String(e.scope)}`)
        continue
      }
      if (!title) {
        out.warnings.push(`skipped ${ref}: no title`)
        continue
      }
      const id = `T-${n++}`
      let fix: Fix | null = null
      if (e.fix !== undefined && e.fix !== null) {
        const v = validateFix(e.fix)
        fix = v.fix
        if (!fix) out.warnings.push(`${id}: dropped its fix (${v.why})`)
      }
      const detail = str(e.detail, 1000)
      out.events.push({ ...base, id, event: "created", kind, scope: scope.toLowerCase(), title, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}), report })
      out.created.push(id)
      if (ref.toLowerCase() !== "new") out.placeholders.set(ref.toLowerCase(), id)
      continue
    }
    const f = items.get(ref.toUpperCase())
    if (!f) {
      out.warnings.push(`skipped a reference to ${ref}, which isn't in the ledger`)
      continue
    }
    const text = str(e.text, 1000)
    if (e.event === "regressed" && (f.state === "done" || f.state === "snoozed")) {
      out.events.push({ ...base, id: f.id, event: "regressed", ...(text ? { text } : {}), report })
      out.regressed.push({ id: f.id, title: f.title, text })
    } else {
      // still-open, or a regressed on an item that's already open: attach the report.
      out.events.push({ ...base, id: f.id, event: "report", report, ...(text ? { text } : {}) })
      out.stillOpen.push(f.id)
    }
  }
  return out
}

// One or two lines for the page that announces the report.
export function todoNote(a: Applied): string {
  const parts: string[] = []
  if (a.created.length) parts.push(`${a.created.join(", ")} new`)
  if (a.stillOpen.length) parts.push(`${[...new Set(a.stillOpen)].join(", ")} seen again`)
  const lines = parts.length ? [`To-dos: ${parts.join(" · ")}`] : []
  for (const r of a.regressed) lines.push(`↩️ ${r.id} is back: ${r.title}${r.text ? `. ${r.text}` : ""}`)
  if (a.warnings.length) lines.push(`⚠️ ${a.warnings.length} to-do ${a.warnings.length === 1 ? "entry was" : "entries were"} skipped: ${a.warnings.slice(0, 3).join("; ")}`)
  return lines.join("\n")
}

// The report tags new items by the agent's placeholder ([new-1]); once Sentinel
// has assigned IDs, those become [T-43].
export function fillPlaceholders(body: string, placeholders: Map<string, string>): string {
  if (!placeholders.size) return body
  return body.replace(/\[(new-\w+)\]/gi, (m, p: string) => {
    const id = placeholders.get(p.toLowerCase())
    return id ? `[${id}]` : m
  })
}

// ---- the prompt's section -------------------------------------------------------------------

const PROMPT_CAP = 40
const CLOSED_DAYS = 30

// What the agent sees before it investigates: the items for this incident's sites,
// its server and the fleet. Open and snoozed items, plus anything closed lately so
// it can tell when a fix didn't hold.
export function relevantItems(items: Map<string, Todo>, domains: string[], server: string | null, now: Date): Todo[] {
  const scopes = new Set(["fleet", ...domains.map((d) => `site:${d.toLowerCase()}`), ...domains.map((d) => `server:${d.toLowerCase()}`)])
  if (server) scopes.add(`server:${server.toLowerCase()}`)
  const cutoff = now.getTime() - CLOSED_DAYS * 24 * 3_600_000
  return [...items.values()]
    .filter((f) => scopes.has(f.scope) && f.kind !== "note")
    .filter((f) => f.state === "open" || f.state === "snoozed" || Date.parse(f.changedAt) >= cutoff)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, PROMPT_CAP)
}

export function ledgerSection(list: Todo[], now: Date): string {
  if (!list.length) return "There are no to-dos on record yet for these sites, their server or the fleet."
  const lines = list.map((f) => {
    const state = effectiveState(f, now)
    const label = state === "snoozed" && f.until ? `snoozed until ${f.until}` : state
    const said = [...f.comments].reverse().find((c) => c.by.startsWith("operator"))
    const noted = [...f.comments].reverse().find((c) => c.by.startsWith("claude"))
    return (
      `- ${f.id} [${label}, ${f.kind}, ${f.scope}] ${f.title}` +
      (said ? `\n  The operator said (${said.at.slice(0, 10)}): "${said.text}"` : "") +
      (noted ? `\n  A Claude session noted (${noted.at.slice(0, 10)}): "${noted.text}"` : "")
    )
  })
  return lines.join("\n")
}

export const BLOCK_INSTRUCTIONS = `After the report, end your answer with a fenced block, \`\`\`todos ... \`\`\`, holding a JSON list: the to-do list Sentinel keeps for the operator. One entry per bullet in your Follow-ups section:

- A new one: {"ref": "new-1", "kind": "...", "scope": "...", "title": "...", "detail": "..."}. Number them new-1, new-2, and so on, and tag the matching bullet in the report with [new-1], which Sentinel replaces with the real ID. kind is one of ${TODO_KINDS.join(", ")}: monitoring is Uptime Kuma, plugin is plugin, theme or core code, server is the OS, PHP-FPM, Redis or swap, sentinel is tuning Sentinel or SpinupTUI, decision needs the operator's call, watch means check again if it recurs, and note is something you did yourself (it's recorded, never open). Something you tried and couldn't do, such as an edit you weren't allowed to make, is not a note: it's a to-do for a person, of the kind it concerns. scope is "site:<domain>", "server:<server host>" or "fleet". title is one short line; detail says why.
- One already on record: {"ref": "T-12", "event": "still-open", "text": "what this incident adds"}, and tag the bullet [T-12]. Don't create a new item for something already on record.
- One marked done whose problem is back: {"ref": "T-7", "event": "regressed", "text": "the evidence"}.

Only for kind nginx, and only when the change is one of these, add a fix: {"template": "deny-paths", "params": {"paths": ["= /exact", "^~ /prefix/", "~ ^/regex\\\\.php$"], "status": 403}}, {"template": "gone-paths", "params": {"paths": [...]}}, {"template": "block-user-agent", "params": {"pattern": "..."}}, or {"template": "cloudflare-real-ip", "params": {}} when a proxied site's log shows only Cloudflare addresses. Any other nginx change has no fix; describe it in detail instead.

If there are no follow-ups, write the block with an empty list.`

export const LEDGER_RULES = `- Refer to an item on record by its ID rather than writing it up again.
- Don't recommend something marked wontfix. If the evidence now argues for it, add one still-open entry on that item saying what changed.
- The operator's words are marked as theirs. A Claude session's notes are another agent's findings, often checked against live data, but still not the operator's decision. Everything else in the list came from earlier diagnoses: a hypothesis, like an earlier report.`

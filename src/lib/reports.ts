// The Reports tab's data: Sentinel's reports, joined with the incident records
// that wrote them and the to-do list (docs/2026-11-11_samurai-spec.md, "The
// Report Browser").
//
// Reports are the files in the workspace (sites/<site>/incidents/*.md), not the
// incident records: those are pruned after 30 days and don't exist at all for
// reports written by hand or before Sentinel. A record, when there is one, gives
// the report its summary and monitor kind.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isOpen, type Todo } from "./todos.ts"
import type { Incident } from "./sentinelState.ts"

// The two lines every report opens with since 2026-11-13: what went wrong, and
// what to do. A report with updates may have several pairs; the last one is
// where things stand.
export interface InShort {
  problem: string
  fix: string
}

export function inShort(text: string): InShort | null {
  const problems = [...text.matchAll(/^\*\*Problem:\*\*\s*(.+)$/gm)]
  const fixes = [...text.matchAll(/^\*\*Fix:\*\*\s*(.+)$/gm)]
  const problem = problems.at(-1)?.[1]
  const fix = fixes.at(-1)?.[1]
  return problem && fix ? { problem: plain(problem), fix: plain(fix) } : null
}

export interface ReportRow {
  path: string // relative to the workspace: sites/<site>/incidents/<file>.md
  site: string
  date: string // YYYY-MM-DD
  time: string // HH:MM as the report gives it, or ""
  kind: string
  summary: string
  short: InShort | null
  todos: string[] // IDs of the items that list this report
  open: number // how many of those are open now
}

const KINDS = ["health", "healthz", "fatal", "redis", "bypass", "push", "fingerprint", "cron-email"]

const TITLE = /^#\s+(\d{2})\/(\d{2})\/(\d{4})\s+\((\d{1,2}:\d{2})[^)]*\)\s+-\s+(\S+)\s+-\s+(\S+)/
const FILE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/

// A pointer left under a second site ("See [the report under …]") isn't a
// report of its own: the real one is listed under its site.
export function isPointer(text: string): boolean {
  const first = text.split("\n").find((l) => l.trim()) ?? ""
  return /^See \[the report under /.test(first.trim())
}

const plain = (s: string) =>
  s
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

// The Symptom section's first paragraph, or else the first paragraph that isn't a
// heading: what a report written before Sentinel kept summaries says first.
export function firstParagraph(text: string): string {
  const lines = text.split("\n")
  const sym = lines.findIndex((l) => /^##\s+Symptom/i.test(l))
  const from = sym >= 0 ? sym + 1 : 0
  const para: string[] = []
  for (const l of lines.slice(from)) {
    if (/^#/.test(l)) {
      if (para.length) break
      continue
    }
    if (!l.trim()) {
      if (para.length) break
      continue
    }
    para.push(l)
  }
  return plain(para.join(" "))
}

export function parseReport(path: string, text: string, incident?: Incident): ReportRow | null {
  const parts = path.split("/")
  const file = parts.at(-1) ?? ""
  const site = parts.at(-3) ?? ""
  const fm = FILE.exec(file)
  if (!fm || isPointer(text)) return null
  const tm = TITLE.exec(text.split("\n", 1)[0] ?? "")
  const kind =
    incident?.events[0]?.kind ??
    (tm ? tm[6]! : null) ??
    KINDS.filter((k) => `-${fm[2]}-`.includes(`-${k}-`)).sort((a, b) => b.length - a.length)[0] ??
    ""
  const time = incident?.createdAt ? incident.createdAt.slice(11, 16) : tm ? tm[4]!.padStart(5, "0") : ""
  return {
    path,
    site,
    date: fm[1]!,
    time,
    kind,
    summary: incident?.summary ? plain(incident.summary) : firstParagraph(text),
    short: inShort(text),
    todos: [],
    open: 0,
  }
}

// Joins each report with the to-dos that name it, and sorts newest first.
export function withTodos(rows: ReportRow[], items: Map<string, Todo>, now: Date): ReportRow[] {
  const byReport = new Map<string, Todo[]>()
  for (const f of items.values()) for (const r of f.reports) byReport.set(r, [...(byReport.get(r) ?? []), f])
  return rows
    .map((r) => {
      const list = byReport.get(r.path) ?? []
      return { ...r, todos: list.map((f) => f.id), open: list.filter((f) => isOpen(f, now)).length }
    })
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`) || b.path.localeCompare(a.path))
}

// Every report in the workspace. Reads each file once, which for a few hundred
// reports is a few milliseconds.
export function scanReports(workspace: string, incidents: Incident[]): ReportRow[] {
  const sites = join(workspace, "sites")
  if (!existsSync(sites)) return []
  // An update's record names the report it updates; the original's says what the
  // report is about, so it wins.
  const withPath = incidents.filter((i) => i.reportPath).sort((a, b) => (a.refersTo ? 0 : 1) - (b.refersTo ? 0 : 1))
  const byPath = new Map(withPath.map((i) => [i.reportPath!, i]))
  const out: ReportRow[] = []
  for (const site of readdirSync(sites)) {
    const dir = join(sites, site, "incidents")
    let files: string[] = []
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue
      const path = `sites/${site}/incidents/${f}`
      let text = ""
      try {
        text = readFileSync(join(dir, f), "utf8")
      } catch {
        continue
      }
      const row = parseReport(path, text, byPath.get(path))
      if (row) out.push(row)
    }
  }
  return out
}

// ---- a site's open count, for site details ---------------------------------------------

export function openCountsBySite(items: Map<string, Todo>, now: Date): Map<string, number> {
  const counts = new Map<string, number>()
  for (const f of items.values()) {
    if (!f.scope.startsWith("site:") || !isOpen(f, now)) continue
    const site = f.scope.slice(5)
    counts.set(site, (counts.get(site) ?? 0) + 1)
  }
  return counts
}

// ---- wrapping, for the report pane ----------------------------------------------------------

// Word-wraps one line to `width` columns. Continuation lines get `indent`, so a
// list item's text lines up under itself. A word longer than the width is split.
export function wrapText(line: string, width: number, indent = ""): string[] {
  const w = Math.max(8, width)
  if (line.length <= w) return [line]
  const lead = /^\s*/.exec(line)![0]
  const words = line.slice(lead.length).split(/\s+/).filter(Boolean)
  const out: string[] = []
  let cur = lead
  const room = () => w - cur.length
  for (let word of words) {
    const sep = cur.trim() ? " " : ""
    if (sep.length + word.length <= room()) {
      cur += sep + word
      continue
    }
    if (cur.trim()) out.push(cur)
    cur = indent
    while (word.length > w - cur.length) {
      const take = Math.max(1, w - cur.length)
      out.push(cur + word.slice(0, take))
      word = word.slice(take)
    }
    cur += word
  }
  if (cur.trim()) out.push(cur)
  return out.length ? out : [""]
}

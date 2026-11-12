// Where the Reports tab gets its reports and to-do list: the Sentinel workspace
// and the ledger on disk, or in Dev Mode the fixtures, with changes kept in
// memory so nothing is written.

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../config.ts"
import { isDevMode } from "../dev/devMode.ts"
import { FIXTURE_LEDGER, FIXTURE_REPORTS } from "../dev/reportFixtures.ts"
import { openCountsBySite, parseReport, scanReports, withTodos, type ReportRow } from "../lib/reports.ts"
import { changeTodo, commitLedger, planChange, type ChangeInput, type Changed } from "../lib/todoActions.ts"
import { fold, ledgerPath, readLedger, type Ledger, type TodoEvent } from "../lib/todos.ts"
import { loadIncidents, sentinelSettings } from "../lib/sentinelState.ts"

export interface ReportSource {
  workspace: string
  ledger(): Ledger
  reports(items: Ledger["items"], now: Date): ReportRow[]
  read(path: string): string | null
  file(path: string): string | null // an absolute path to open, or null
  change(id: string, input: ChangeInput): Changed
  commit(message: string): Promise<string | null>
  stamp(): string // changes when the ledger does
}

function diskSource(): ReportSource {
  const workspace = sentinelSettings(loadConfig()).workspace
  return {
    workspace,
    ledger: () => readLedger(),
    reports: (items, now) => withTodos(scanReports(workspace, loadIncidents()), items, now),
    read: (path) => {
      try {
        return readFileSync(join(workspace, path), "utf8")
      } catch {
        return null
      }
    },
    file: (path) => join(workspace, path),
    change: (id, input) => changeTodo(id, input),
    commit: (message) => commitLedger(message),
    stamp: () => {
      try {
        const s = statSync(ledgerPath())
        return `${s.mtimeMs}:${s.size}`
      } catch {
        return "none"
      }
    },
  }
}

const devEvents: TodoEvent[] = [...FIXTURE_LEDGER]

function devSource(): ReportSource {
  const ledger = (): Ledger => ({ items: fold(devEvents), events: devEvents, skipped: 0 })
  return {
    workspace: "~/SpinupTUI/sentinel (Dev Mode fixtures)",
    ledger,
    reports: (items, now) =>
      withTodos(
        FIXTURE_REPORTS.flatMap((r) => {
          const row = parseReport(r.path, r.text)
          return row ? [{ ...row, ...(r.summary ? { summary: r.summary } : {}) }] : []
        }),
        items,
        now,
      ),
    read: (path) => FIXTURE_REPORTS.find((r) => r.path === path)?.text ?? null,
    file: () => null,
    change: (rawId, input) => {
      const f = ledger().items.get(rawId.toUpperCase())
      if (!f) return { ok: false, reason: "unknown_todo", message: `No to-do "${rawId}".` }
      const p = planChange(f, input)
      if (p.ok) devEvents.push(p.event)
      return p
    },
    commit: async () => null,
    stamp: () => String(devEvents.length),
  }
}

let source: ReportSource | null = null
export function reportSource(): ReportSource {
  source ??= isDevMode() ? devSource() : diskSource()
  return source
}

// Site details redraw often, so the counts are refolded only when the ledger
// changes, or the day does (a snooze runs out at midnight with no write).
let counts: { key: string; map: Map<string, number> } | null = null
export function openTodosForSite(domain: string): number {
  const src = reportSource()
  const now = new Date()
  const key = `${src.stamp()}|${now.toISOString().slice(0, 10)}`
  if (counts?.key !== key) counts = { key, map: openCountsBySite(src.ledger().items, now) }
  return counts.map.get(domain.toLowerCase()) ?? 0
}

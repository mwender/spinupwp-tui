// Reports tab: Sentinel's reports, and the to-do list they feed
// (docs/2026-11-11_samurai-spec.md, "The Report Browser"). Two lists, toggled
// with Tab. Reports: newest first, Enter reads one in the right pane. To-dos:
// grouped fleet → server → site, with the operator's actions, each one an
// event appended to the ledger and committed like the CLI's.

import { useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { openUrl } from "../../lib/open.ts"
import { Panel } from "../components.tsx"
import { List } from "../List.tsx"
import { StatusBar, type KeyHint } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { toast } from "../toast.ts"
import { reportSource } from "../reportSource.ts"
import { wrapText, type ReportRow } from "../../lib/reports.ts"
import { effectiveState, sortById, TODO_KINDS, type Ledger, type Todo, type TodoKind } from "../../lib/todos.ts"
import { operator, stateLabel, type TodoAction } from "../../lib/todoActions.ts"

type ListName = "reports" | "todos"
type StateFilter = "open" | "snoozed" | "done" | "wontfix" | "all"
const STATE_FILTERS: StateFilter[] = ["open", "snoozed", "done", "wontfix", "all"]

type TodoRow = { type: "header"; label: string; key: string } | { type: "todo"; f: Todo; key: string }

interface Prompt {
  action: TodoAction
  id: string
  title: string
  label: string
  required: boolean
  value: string
}

const INPUT_STYLE = { backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }

const STATE_COLOR: Record<string, string> = { open: theme.warn, snoozed: theme.purple, done: theme.good, wontfix: theme.textDim }

const scopeOrder = (s: string) => (s === "fleet" ? 0 : s.startsWith("server:") ? 1 : 2)
const scopeLabel = (s: string) => (s === "fleet" ? "Fleet" : s.startsWith("server:") ? `Server  ${s.slice(7)}` : `Site  ${s.slice(5)}`)

function groupTodos(list: Todo[]): TodoRow[] {
  const groups = new Map<string, Todo[]>()
  for (const f of list) groups.set(f.scope, [...(groups.get(f.scope) ?? []), f])
  const scopes = [...groups.keys()].sort((a, b) => scopeOrder(a) - scopeOrder(b) || a.localeCompare(b))
  return scopes.flatMap((s) => [{ type: "header" as const, label: scopeLabel(s), key: `h:${s}` }, ...groups.get(s)!.sort(sortById).map((f) => ({ type: "todo" as const, f, key: f.id }))])
}

const plusDays = (now: Date, n: number) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10)

// What each action asks for. Won't fix needs its reason because Sentinel reads it
// before it recommends the same thing again.
function promptFor(action: TodoAction, f: Todo, now: Date): Prompt {
  const base = { action, id: f.id, title: `${f.id}  ${f.title}` }
  switch (action) {
    case "done":
      return { ...base, label: "Done. A comment, if you like (what you did):", required: false, value: "" }
    case "wontfix":
      return { ...base, label: "Won't fix. Why? Sentinel reads this before it recommends it again:", required: true, value: "" }
    case "snooze":
      return { ...base, label: "Snooze until (YYYY-MM-DD), then a comment if you like:", required: true, value: `${plusDays(now, 7)} ` }
    case "comment":
      return { ...base, label: "Comment:", required: true, value: "" }
    case "reopen":
      return { ...base, label: "Reopen. A comment, if you like (why):", required: false, value: "" }
  }
}

const ACTION_KEYS: Record<string, TodoAction> = { d: "done", w: "wontfix", s: "snooze", c: "comment", r: "reopen" }

// Which actions make sense for an item in this state. The legend shows only these.
function actionsFor(f: Todo, now: Date): TodoAction[] {
  const state = effectiveState(f, now)
  if (state === "open") return ["done", "wontfix", "snooze", "comment"]
  if (state === "snoozed") return ["done", "wontfix", "snooze", "comment", "reopen"]
  return ["comment", "reopen"]
}

// Why `f` isn't available. Samurai, which applies template fixes, arrives in a
// later version; until then every answer is one of these.
function samuraiReason(f: Todo): string {
  if (f.kind !== "nginx") return `${f.id} is ${f.kind} work. Samurai only applies nginx fixes, so this one is done by hand.`
  if (!f.fix) return `No Samurai template covers ${f.id}, so it's an nginx change made by hand.`
  return `${f.id} has a ${f.fix.template} fix ready. Samurai, which applies it, arrives in a later version.`
}

export function Reports({ rows }: { rows: number }) {
  const { route, inputMode, overlayOpen, setInputMode, reportsSite, setReportsSite } = useStore()
  const { width } = useTerminalDimensions()
  const src = reportSource()
  const [list, setList] = useState<ListName>("reports")
  const [reading, setReading] = useState(false)
  const [scroll, setScroll] = useState(0)
  const [reportSel, setReportSel] = useState(0)
  const [todoSel, setTodoSel] = useState(1)
  const [stateFilter, setStateFilter] = useState<StateFilter>("open")
  const [kindFilter, setKindFilter] = useState<TodoKind | null>(null)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [promptError, setPromptError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [data, setData] = useState<{ ledger: Ledger; reports: ReportRow[]; stamp: string } | null>(null)

  const active = route === "reports"
  const now = new Date()

  const stamp = useRef("")
  const load = () => {
    const ledger = src.ledger()
    stamp.current = src.stamp()
    setData({ ledger, reports: src.reports(ledger.items, new Date()), stamp: stamp.current })
  }

  // Load on opening the tab, and pick up changes from elsewhere (the worker, the
  // CLI, another machine's merge) while it's open.
  useEffect(() => {
    if (!active) return
    load()
    const t = setInterval(() => {
      if (src.stamp() !== stamp.current) load()
    }, 5_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const say = (msg: string, ms = 4000) => {
    setFlash(msg)
    setTimeout(() => setFlash((m) => (m === msg ? null : m)), ms)
  }

  const reports = useMemo(() => (data?.reports ?? []).filter((r) => !reportsSite || r.site === reportsSite), [data, reportsSite])

  const todoRows = useMemo(() => {
    const items = [...(data?.ledger.items.values() ?? [])]
      .filter((f) => stateFilter === "all" || effectiveState(f, now) === stateFilter)
      .filter((f) => !kindFilter || f.kind === kindFilter)
      .filter((f) => !reportsSite || f.scope === `site:${reportsSite}`)
    return groupTodos(items)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, stateFilter, kindFilter, reportsSite])

  // Keep the selections in range, and off the group headings.
  useEffect(() => {
    setReportSel((i) => Math.min(i, Math.max(0, reports.length - 1)))
  }, [reports.length])
  useEffect(() => {
    setTodoSel((i) => {
      if (!todoRows.length) return 0
      let n = Math.min(i, todoRows.length - 1)
      while (n < todoRows.length - 1 && todoRows[n]!.type === "header") n++
      while (n > 0 && todoRows[n]!.type === "header") n--
      return n
    })
  }, [todoRows])

  const report = reports[reportSel]
  const todoRow = todoRows[todoSel]
  const todo = todoRow?.type === "todo" ? todoRow.f : undefined

  const leftWidth = Math.max(46, Math.floor(width * 0.48))
  const paneWidth = Math.max(20, width - leftWidth - 2 - 1 - 4)
  const viewRows = Math.max(3, rows - 5)

  const reportPath = list === "reports" ? report?.path : todo ? newestReport(todo, data?.reports ?? []) : undefined
  const reportLines = useMemo(() => (reading && reportPath ? markdownLines(src.read(reportPath) ?? "This report's file is gone.", paneWidth) : []), [reading, reportPath, paneWidth, src])

  const moveTodo = (delta: number) => {
    if (!todoRows.length) return
    let n = todoSel
    for (;;) {
      const next = n + delta
      if (next < 0 || next >= todoRows.length) return
      n = next
      if (todoRows[n]!.type === "todo") return setTodoSel(n)
    }
  }

  const openFile = (path: string | undefined) => {
    if (!path) return say("No report to open.")
    const abs = src.file(path)
    if (!abs) return say("Dev Mode's reports aren't files on disk.")
    openUrl(abs)
    say(`Opening ${path}…`, 2000)
  }

  const submit = () => {
    if (!prompt) return
    let text = prompt.value.trim()
    let until: string | undefined
    if (prompt.action === "snooze") {
      const m = /^(\S+)\s*(.*)$/.exec(text)
      until = m?.[1] ?? ""
      text = m?.[2] ?? ""
    }
    if (prompt.required && prompt.action !== "snooze" && !text) return setPromptError(prompt.action === "wontfix" ? "A reason is required: Sentinel reads it." : "Nothing to say yet.")
    const r = src.change(prompt.id, { action: prompt.action, text, until, by: operator(), now: new Date() })
    if (!r.ok) return setPromptError(r.message)
    const id = r.event.id
    setPrompt(null)
    setPromptError(null)
    load()
    const after = src.ledger().items.get(id)
    toast.success(prompt.action === "comment" ? `Comment added to ${id}` : `${id} is now ${after ? stateLabel(effectiveState(after, new Date()), after.until) : prompt.action}`)
    void src.commit(`todos: ${id} ${prompt.action}`).then((err) => err && toast.error(`Saved, but not synced: ${err}`))
  }

  // The prompt's input is focused, so only Esc gets here while it's open.
  useEffect(() => {
    if (!prompt) return
    setInputMode(true)
    return () => setInputMode(false)
  }, [prompt, setInputMode])

  useKeyboard((key) => {
    if (!active || overlayOpen) return
    if (prompt) {
      if (key.name === "escape") {
        setPrompt(null)
        setPromptError(null)
      }
      return
    }
    if (inputMode) return
    const name = key.shift && key.name?.length === 1 ? key.name.toUpperCase() : key.name

    if (reading) {
      const max = Math.max(0, reportLines.length - viewRows)
      switch (name) {
        case "up":
        case "k":
          return setScroll((s) => Math.max(0, s - 1))
        case "down":
        case "j":
          return setScroll((s) => Math.min(max, s + 1))
        case "pageup":
        case "b":
          return setScroll((s) => Math.max(0, s - viewRows + 1))
        case "pagedown":
        case "space":
          return setScroll((s) => Math.min(max, s + viewRows - 1))
        case "g":
          return setScroll(0)
        case "G":
          return setScroll(max)
        case "o":
          return openFile(reportPath)
        case "escape":
        case "left":
        case "return":
          return setReading(false)
        case "tab":
          setReading(false)
          return setList((l) => (l === "reports" ? "todos" : "reports"))
      }
      return
    }

    switch (name) {
      case "tab":
        return setList((l) => (l === "reports" ? "todos" : "reports"))
      case "x":
        if (reportsSite) {
          setReportsSite(null)
          say("Showing every site.", 2000)
        }
        return
      case "o":
        return openFile(reportPath)
    }

    if (list === "reports") {
      switch (name) {
        case "up":
        case "k":
          return setReportSel((i) => Math.max(0, i - 1))
        case "down":
        case "j":
          return setReportSel((i) => Math.min(reports.length - 1, i + 1))
        case "g":
          return setReportSel(0)
        case "G":
          return setReportSel(Math.max(0, reports.length - 1))
        case "return":
        case "right":
          if (!report) return
          setScroll(0)
          return setReading(true)
        case "r":
          load()
          return say("Reloaded.", 1500)
        case "d":
        case "w":
        case "s":
        case "c":
        case "f":
          return say("Press Tab for the to-do list, where those keys act on the selected item.")
      }
      return
    }

    switch (name) {
      case "up":
      case "k":
        return moveTodo(-1)
      case "down":
      case "j":
        return moveTodo(1)
      case "v": {
        const next = STATE_FILTERS[(STATE_FILTERS.indexOf(stateFilter) + 1) % STATE_FILTERS.length]!
        setStateFilter(next)
        return say(`Showing ${next === "all" ? "every state" : stateLabel(next)}.`, 1500)
      }
      case "t": {
        const order: (TodoKind | null)[] = [null, ...TODO_KINDS]
        const next = order[(order.indexOf(kindFilter) + 1) % order.length]!
        setKindFilter(next)
        return say(next ? `Showing ${next} to-dos.` : "Showing every kind.", 1500)
      }
      case "f":
        return todo && say(samuraiReason(todo), 6000)
      case "return":
      case "right": {
        if (!todo) return
        const path = newestReport(todo, data?.reports ?? [])
        const i = path ? reports.findIndex((r) => r.path === path) : -1
        if (i < 0) return say(path ? `${todo.id}'s report isn't in the list${reportsSite ? " for this site" : ""}.` : `${todo.id} has no report.`)
        setList("reports")
        setReportSel(i)
        setScroll(0)
        return setReading(true)
      }
    }
    const action = name ? ACTION_KEYS[name] : undefined
    if (action && todo) {
      if (!actionsFor(todo, now).includes(action)) return say(`${todo.id} is ${stateLabel(effectiveState(todo, now))}, so ${action === "reopen" ? "there's nothing to reopen" : `it can't be marked ${stateLabel(action === "snooze" ? "snoozed" : action)}`}.`)
      setPromptError(null)
      return setPrompt(promptFor(action, todo, now))
    }
  })

  if (!data) return <box style={{ flexGrow: 1 }} />

  const openCount = [...data.ledger.items.values()].filter((f) => effectiveState(f, now) === "open").length
  const filterBits = [reportsSite ? `site ${reportsSite}` : null, list === "todos" ? (stateFilter === "all" ? "every state" : stateLabel(stateFilter)) : null, list === "todos" && kindFilter ? kindFilter : null].filter(Boolean)

  const hints: KeyHint[] = reading
    ? [
        { key: "↑↓/space", label: "scroll" },
        { key: "o", label: "open the file" },
        { key: "esc", label: "back" },
      ]
    : list === "reports"
      ? [
          { key: "Tab", label: "to-dos" },
          { key: "⏎", label: "read" },
          { key: "o", label: "open the file" },
          { key: "r", label: "reload" },
          ...(reportsSite ? [{ key: "x", label: "every site" }] : []),
        ]
      : [
          { key: "Tab", label: "reports" },
          ...(todo
            ? [
                ...actionsFor(todo, now).map((a) => ({ key: a === "done" ? "d" : a === "wontfix" ? "w" : a === "snooze" ? "s" : a === "comment" ? "c" : "r", label: a === "wontfix" ? "won't fix" : a })),
                ...(todo.reports.length ? [{ key: "⏎", label: "its report" }] : []),
              ]
            : []),
          { key: "v", label: "state" },
          { key: "t", label: "kind" },
          ...(reportsSite ? [{ key: "x", label: "every site" }] : []),
        ]

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row", padding: 1, gap: 1 }}>
        <Panel
          title={list === "reports" ? ` Reports (${reports.length}) · To-dos ` : ` Reports · To-dos (${todoRows.filter((r) => r.type === "todo").length}) `}
          bottomTitle={filterBits.length ? ` ${filterBits.join(" · ")} ` : undefined}
          active={!reading}
          width={leftWidth}
        >
          {list === "reports" ? (
            <List
              items={reports}
              selectedIndex={reportSel}
              viewportRows={viewRows}
              focused={!reading}
              keyFor={(r) => r.path}
              emptyText={reportsSite ? `No reports for ${reportsSite}.` : `No reports yet in ${src.workspace}.`}
              renderRow={(r, sel) => (
                <>
                  <text content={`${r.date.slice(5)} ${r.time.padEnd(5)} `} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
                  <text content={`${truncate(r.site, 22).padEnd(22)} `} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
                  <text content={`${truncate(r.kind, 8).padEnd(8)} `} fg={theme.accent} wrapMode="none" style={{ flexShrink: 0 }} />
                  <text content={r.open ? `${r.open} open `.padStart(7) : "".padStart(7)} fg={theme.warn} wrapMode="none" style={{ flexShrink: 0 }} />
                  <text content={r.summary} fg={sel ? theme.text : theme.textFaint} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                </>
              )}
            />
          ) : (
            <List
              items={todoRows}
              selectedIndex={todoSel}
              viewportRows={viewRows}
              focused={!reading}
              keyFor={(r) => r.key}
              emptyText={openCount === 0 && stateFilter === "open" && !kindFilter ? "Nothing open. Sentinel adds to-dos here as its reports recommend them." : "No to-dos match. v changes the state shown, t the kind."}
              renderRow={(r, sel) =>
                r.type === "header" ? (
                  <text content={r.label} fg={theme.purple} attributes={1} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                ) : (
                  <>
                    <text content={`  ${r.f.id.padEnd(6)}`} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
                    <text content={`${stateLabel(effectiveState(r.f, now)).padEnd(10)}`} fg={STATE_COLOR[effectiveState(r.f, now)] ?? theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
                    <text content={`${r.f.kind.padEnd(11)}`} fg={theme.accent} wrapMode="none" style={{ flexShrink: 0 }} />
                    <text content={r.f.title} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  </>
                )
              }
            />
          )}
        </Panel>

        <Panel title={reading ? ` ${truncate(reportPath ?? "", paneWidth - 4)} ` : list === "reports" ? " Report " : " To-do "} active={reading} flexGrow={1} bottomTitle={reading && reportLines.length > viewRows ? ` ${Math.min(100, Math.round(((scroll + viewRows) / reportLines.length) * 100))}% ` : undefined}>
          {flash && !reading && (
            <box style={{ flexDirection: "column", flexShrink: 0 }}>
              <Lines lines={para(flash, paneWidth, theme.accent)} />
              <box style={{ height: 1 }} />
            </box>
          )}
          {reading ? (
            <Lines lines={reportLines.slice(scroll, scroll + viewRows)} />
          ) : list === "reports" ? (
            report ? (
              <Lines lines={reportPreview(report, data.ledger, now, paneWidth).slice(0, viewRows)} />
            ) : (
              <text content="Sentinel writes a report for every incident it diagnoses. They appear here, newest first." fg={theme.textDim} />
            )
          ) : todo ? (
            <Lines lines={todoDetail(todo, data.reports, now, paneWidth).slice(0, viewRows)} />
          ) : (
            <text content="Select a to-do to see why it's on the list, the reports it appears in, and its history." fg={theme.textDim} />
          )}
        </Panel>
      </box>
      {prompt && <PromptBox prompt={prompt} error={promptError} width={Math.min(84, width - 6)} onInput={(v) => (setPrompt({ ...prompt, value: v }), setPromptError(null))} onSubmit={submit} />}
      <StatusBar hints={prompt ? [{ key: "⏎", label: "save" }, { key: "esc", label: "cancel" }] : hints} message={reading && flash ? flash : undefined} messageColor={theme.accent} showGlobal={!prompt} omitGlobal={["r"]} />
    </box>
  )
}

function PromptBox({ prompt, error, width, onInput, onSubmit }: { prompt: Prompt; error: string | null; width: number; onInput: (v: string) => void; onSubmit: () => void }) {
  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", justifyContent: "center", alignItems: "center", zIndex: 200 }}>
      <Panel title={` ${prompt.action === "wontfix" ? "Won't fix" : prompt.action[0]!.toUpperCase() + prompt.action.slice(1)} `} active style={{ backgroundColor: theme.bg, width }}>
        <box style={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }}>
          <text content={truncate(prompt.title, width - 4)} fg={theme.text} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content={prompt.label} fg={theme.accent} />
          <input focused value={prompt.value} onInput={onInput} onSubmit={onSubmit} style={INPUT_STYLE} />
          <box style={{ height: 1 }} />
          {error ? <text content={`✕ ${error}`} fg={theme.bad} /> : <text content="Saved to the to-do list and synced with your SpinupTUI folder." fg={theme.textFaint} wrapMode="none" />}
        </box>
      </Panel>
    </box>
  )
}

// ---- the right pane --------------------------------------------------------------------

interface Line {
  text: string
  color?: string
  bold?: boolean
}

function Lines({ lines }: { lines: Line[] }) {
  return (
    <box style={{ flexDirection: "column" }}>
      {lines.map((l, i) => (
        <text key={i} content={l.text || " "} fg={l.color ?? theme.text} attributes={l.bold ? 1 : 0} wrapMode="none" />
      ))}
    </box>
  )
}

const para = (text: string, width: number, color?: string, indent = ""): Line[] => wrapText(text, width, indent).map((t) => ({ text: t, ...(color ? { color } : {}) }))
const blank: Line = { text: "" }

function markdownLines(text: string, width: number): Line[] {
  const out: Line[] = []
  let fenced = false
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (/^```/.test(raw)) {
      fenced = !fenced
      out.push({ text: raw, color: theme.textFaint })
      continue
    }
    if (fenced) {
      out.push({ text: raw, color: theme.textDim })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (h) {
      out.push(...para(h[2]!, width, h[1]!.length === 1 ? theme.brand : theme.accent).map((l) => ({ ...l, bold: true })))
      continue
    }
    const item = /^(\s*(?:[-*]|\d+\.)\s+)/.exec(raw)
    out.push(...para(raw, width, undefined, item ? " ".repeat(item[1]!.length) : ""))
  }
  return out
}

function newestReport(f: Todo, reports: ReportRow[]): string | undefined {
  const order = new Map(reports.map((r, i) => [r.path, i]))
  // reports is newest first; one the list doesn't know sorts last.
  return [...f.reports].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))[0]
}

function reportPreview(r: ReportRow, ledger: Ledger, now: Date, width: number): Line[] {
  const todos = r.todos.map((id) => ledger.items.get(id)).filter((f): f is Todo => !!f)
  return [
    { text: r.site, bold: true },
    { text: `${r.date}${r.time ? ` ${r.time}` : ""}  ·  ${r.kind || "monitor unknown"}`, color: theme.textDim },
    blank,
    ...para(r.summary || "No summary.", width),
    blank,
    { text: todos.length ? `To-dos (${r.open} open):` : "No to-dos recorded for this report.", color: theme.textDim },
    ...todos.flatMap((f) => {
      const lead = `${f.id.padEnd(6)}${stateLabel(effectiveState(f, now)).padEnd(11)}`
      return wrapText(f.title, width - lead.length).map((t, i) => ({ text: (i ? " ".repeat(lead.length) : lead) + t, color: STATE_COLOR[effectiveState(f, now)] }))
    }),
    blank,
    { text: "⏎ read the report  ·  o open the file", color: theme.accent },
    ...para(r.path, width, theme.textFaint),
  ]
}

const historyLine = (e: Todo["history"][number]) => {
  const what = e.event === "snoozed" ? `snoozed until ${e.until}` : e.event === "wontfix" ? "won't fix" : e.event === "report" ? "seen again" : e.event
  const text = "text" in e && e.text ? `: ${e.text}` : ""
  return `${e.at.slice(0, 16).replace("T", " ")}  ${e.by}  ${what}${text}`
}

function todoDetail(f: Todo, reports: ReportRow[], now: Date, width: number): Line[] {
  const state = effectiveState(f, now)
  const known = new Set(reports.map((r) => r.path))
  return [
    ...para(`${f.id}  ${f.title}`, width).map((l) => ({ ...l, bold: true })),
    { text: `${stateLabel(state, f.until)}  ·  ${f.kind}  ·  ${f.scope}`, color: STATE_COLOR[state] ?? theme.textDim },
    blank,
    ...(f.detail ? [...para(f.detail, width), blank] : []),
    ...(f.fix ? [{ text: `Fix: ${f.fix.template}`, color: theme.accent }, ...para(JSON.stringify(f.fix.params), width, theme.textDim, "  "), blank] : []),
    { text: f.reports.length === 1 ? "Report:" : `Reports (${f.reports.length}):`, color: theme.textDim },
    ...f.reports.flatMap((p) => para(`${p}${known.has(p) ? "" : "  (not found)"}`, width, known.has(p) ? theme.text : theme.textFaint)),
    blank,
    { text: "History:", color: theme.textDim },
    ...f.history.flatMap((e) => para(historyLine(e), width, e.by.startsWith("operator") ? theme.text : theme.textDim, "  ")),
  ]
}

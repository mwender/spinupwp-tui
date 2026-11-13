import { describe, expect, test } from "bun:test"
import { firstParagraph, inShort, isPointer, openCountsBySite, parseReport, withTodos, wrapText } from "./reports.ts"
import { fold, type TodoEvent } from "./todos.ts"
import type { Incident } from "./sentinelState.ts"
import { planChange } from "./todoActions.ts"

const P = "sites/example.com/incidents/2026-11-12-fatal-late-beat.md"
const NOW = new Date("2026-11-12T12:00:00Z")

describe("parseReport", () => {
  test("reads the date from the file, and site, time and kind from the title", () => {
    const r = parseReport(P, "# 11/12/2026 (08:40) - example.com - fatal\n\n## Symptom\n\nThe **fatal** monitor paged at `08:40`.\nIt recovered.\n\n## Timeline\n\n- x\n")!
    expect(r).toMatchObject({ site: "example.com", date: "2026-11-12", time: "08:40", kind: "fatal", summary: "The fatal monitor paged at 08:40. It recovered." })
  })

  test("takes the first word of a kind with a note, and tolerates a zone in the time", () => {
    const r = parseReport(P, "# 11/03/2026 (9:05 EDT) - example.com - health (cause: other.org)\n\nBody.\n")!
    expect(r.kind).toBe("health")
    expect(r.time).toBe("09:05")
    expect(r.summary).toBe("Body.")
  })

  test("prefers the incident record's summary, kind and time", () => {
    const inc = { id: "x", createdAt: "2026-11-12T08:40:04Z", events: [{ kind: "redis" }], summary: "From the record." } as unknown as Incident
    expect(parseReport(P, "# 11/12/2026 (03:40) - example.com - fatal\n\nBody.\n", inc)).toMatchObject({ kind: "redis", time: "08:40", summary: "From the record." })
  })

  test("falls back to the file name for the kind when the title has another shape", () => {
    const r = parseReport("sites/a.org/incidents/2026-11-01-cron-email-failed.md", "# 2026-11-01 — a.org cron mail\n\nIt failed.\n")!
    expect(r.kind).toBe("cron-email")
    expect(r.time).toBe("")
  })

  test("skips pointers left under a second site, and files without a date", () => {
    expect(isPointer("See [the report under b.org](../../b.org/incidents/x.md).\n")).toBe(true)
    expect(parseReport(P, "See [the report under b.org](../../b.org/incidents/x.md).\n")).toBeNull()
    expect(parseReport("sites/a.org/incidents/notes.md", "# Notes\n")).toBeNull()
  })

  test("firstParagraph skips headings and strips links", () => {
    expect(firstParagraph("# Title\n\n**Update:** see [the page](https://x).\n\nMore.")).toBe("Update: see the page.")
  })
})

const ev = (e: Record<string, unknown>) => ({ v: 1, by: "sentinel", ...e }) as TodoEvent

describe("withTodos", () => {
  const events = [
    ev({ at: "2026-11-10T00:00:00Z", id: "T-1", event: "created", kind: "nginx", scope: "site:example.com", title: "a", report: P }),
    ev({ at: "2026-11-10T00:00:00Z", id: "T-2", event: "created", kind: "watch", scope: "site:example.com", title: "b", report: P }),
    ev({ at: "2026-11-11T00:00:00Z", id: "T-2", event: "done", by: "operator@x" }),
    ev({ at: "2026-11-11T00:00:00Z", id: "T-3", event: "created", kind: "server", scope: "server:web1.example.com", title: "c" }),
  ]
  const items = fold(events)

  test("counts each report's open to-dos and sorts newest first", () => {
    const older = { ...parseReport("sites/b.org/incidents/2026-11-01-health.md", "x\n")!, time: "23:00" }
    const rows = withTodos([older, parseReport(P, "# 11/12/2026 (08:40) - example.com - fatal\n")!], items, NOW)
    expect(rows.map((r) => r.site)).toEqual(["example.com", "b.org"])
    expect(rows[0]).toMatchObject({ todos: ["T-1", "T-2"], open: 1 })
    expect(rows[1]).toMatchObject({ todos: [], open: 0 })
  })

  test("openCountsBySite counts only open, site-scoped items", () => {
    expect([...openCountsBySite(items, NOW)]).toEqual([["example.com", 1]])
  })
})

describe("wrapText", () => {
  test("wraps on words, indents continuations, and splits a word wider than the line", () => {
    expect(wrapText("- one two three four", 10, "  ")).toEqual(["- one two", "  three", "  four"])
    expect(wrapText("short", 10)).toEqual(["short"])
    expect(wrapText("abcdefghijklmnop", 8)).toEqual(["abcdefgh", "ijklmnop"])
    for (const l of wrapText("x ".repeat(200), 30)) expect(l.length).toBeLessThanOrEqual(30)
  })
})

describe("planChange", () => {
  const items = fold([
    ev({ at: "2026-11-10T00:00:00Z", id: "T-1", event: "created", kind: "nginx", scope: "fleet", title: "a" }),
    ev({ at: "2026-11-10T00:00:00Z", id: "T-2", event: "created", kind: "nginx", scope: "fleet", title: "b" }),
    ev({ at: "2026-11-10T01:00:00Z", id: "T-2", event: "snoozed", until: "2026-11-11", by: "operator@x" }),
  ])
  const base = { by: "operator@test", now: NOW, text: "" }

  test("won't fix needs a reason, and a comment needs text", () => {
    expect(planChange(items.get("T-1")!, { ...base, action: "wontfix" })).toMatchObject({ ok: false, reason: "usage" })
    expect(planChange(items.get("T-1")!, { ...base, action: "comment" })).toMatchObject({ ok: false })
    expect(planChange(items.get("T-1")!, { ...base, action: "wontfix", text: " abandoned " })).toMatchObject({ ok: true, event: { event: "wontfix", text: "abandoned", by: "operator@test", id: "T-1" } })
  })

  test("snooze needs a date that hasn't passed", () => {
    expect(planChange(items.get("T-1")!, { ...base, action: "snooze", until: "soon" })).toMatchObject({ ok: false })
    expect(planChange(items.get("T-1")!, { ...base, action: "snooze", until: "2026-11-01" })).toMatchObject({ ok: false })
    expect(planChange(items.get("T-1")!, { ...base, action: "snooze", until: "2026-11-20" })).toMatchObject({ ok: true, event: { event: "snoozed", until: "2026-11-20" } })
  })

  test("an expired snooze reads as open: done works, reopen is refused", () => {
    expect(planChange(items.get("T-2")!, { ...base, action: "reopen" })).toMatchObject({ ok: false, reason: "already_open" })
    expect(planChange(items.get("T-2")!, { ...base, action: "done" })).toMatchObject({ ok: true })
  })
})

describe("signed by Claude", () => {
  const items = fold([ev({ at: "2026-11-10T00:00:00Z", id: "T-1", event: "created", kind: "monitoring", scope: "fleet", title: "a" })])
  const base = { by: "claude@test", now: NOW, text: "why" }
  test("may comment, mark done and reopen, but not won't fix or snooze", () => {
    expect(planChange(items.get("T-1")!, { ...base, action: "comment" })).toMatchObject({ ok: true, event: { by: "claude@test" } })
    expect(planChange(items.get("T-1")!, { ...base, action: "done" })).toMatchObject({ ok: true })
    expect(planChange(items.get("T-1")!, { ...base, action: "wontfix" })).toMatchObject({ ok: false, reason: "not_allowed" })
    expect(planChange(items.get("T-1")!, { ...base, action: "snooze", until: "2026-12-01" })).toMatchObject({ ok: false, reason: "not_allowed" })
  })
})

describe("inShort", () => {
  test("reads the Problem and Fix lines, the last pair winning after an update", () => {
    const text = "# t\n\n**Problem:** It broke.\n**Fix:** Mend it.\n\n## Symptom\n\nx\n\n## Update\n\n**Problem:** It broke again, from `cron`.\n**Fix:** Nothing to do: it recovered.\n"
    expect(inShort(text)).toEqual({ problem: "It broke again, from cron.", fix: "Nothing to do: it recovered." })
    expect(inShort("# t\n\n**Problem:** only one line\n")).toBeNull()
    expect(parseReport(P, text)!.short?.problem).toBe("It broke again, from cron.")
  })
})

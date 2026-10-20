import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dueOccurrence, fmt, nextRunText, parseEvery, parseWhen } from "./schedule.ts"
import { agentOf, parseJobText, splitArgs, validateJob } from "./schedulerJobs.ts"
import { quoteArg } from "./cliScheduler.ts"
import { renderPlist, renderSystemd } from "./schedulerInstall.ts"
import { runModuleJobs } from "./schedulerTick.ts"
import { summaryOf } from "./schedulerRun.ts"
import { tryLock } from "./flock.ts"

const at = (s: string) => parseWhen(s)

describe("parseEvery", () => {
  test("intervals", () => {
    expect(parseEvery("30m")).toEqual({ type: "interval", minutes: 30 })
    expect(parseEvery("6h")).toEqual({ type: "interval", minutes: 360 })
    expect(() => parseEvery("2m")).toThrow(/5m or longer/)
  })

  test("calendar forms", () => {
    const daily = parseEvery("daily 08:00")
    expect(daily.type === "calendar" && [...daily.days].length).toBe(7)
    const wk = parseEvery("weekdays 8:30")
    expect(wk.type === "calendar" && [...wk.days].sort()).toEqual([0, 1, 2, 3, 4])
    const some = parseEvery("mon,thu 08:00")
    expect(some.type === "calendar" && [...some.days].sort()).toEqual([0, 3])
    expect(() => parseEvery("funday 08:00")).toThrow(/unknown day/)
    expect(() => parseEvery("daily 25:00")).toThrow(/out of range/)
  })
})

describe("dueOccurrence", () => {
  const oneShot = { when: "2026-10-21 08:00", expires: "2026-10-28" }

  test("a one-shot runs once, at or after its time", () => {
    expect(dueOccurrence(oneShot, {}, at("2026-10-21 07:55"))).toBeNull()
    expect(fmt(dueOccurrence(oneShot, {}, at("2026-10-21 08:05")))).toBe("2026-10-21 08:00")
    expect(dueOccurrence(oneShot, { last_scheduled: "2026-10-21 08:00" }, at("2026-10-21 08:10"))).toBeNull()
  })

  test("nothing runs after expires", () => {
    expect(dueOccurrence(oneShot, {}, at("2026-10-28 23:55"))).not.toBeNull()
    expect(dueOccurrence(oneShot, {}, at("2026-10-29 00:00"))).toBeNull()
  })

  test("retry_after holds a job back", () => {
    expect(dueOccurrence(oneShot, { retry_after: "2026-10-21 08:30" }, at("2026-10-21 08:10"))).toBeNull()
    expect(dueOccurrence(oneShot, { retry_after: "2026-10-21 08:30" }, at("2026-10-21 08:30"))).not.toBeNull()
  })

  test("calendar: missed slots collapse into one catch-up run", () => {
    // 2026-10-19 is a Monday.
    const job = { every: "daily 08:00", expires: "2026-12-31", created: "2026-10-01 00:00" }
    const state = { last_scheduled: "2026-10-17 08:00" }
    expect(fmt(dueOccurrence(job, state, at("2026-10-20 09:00")))).toBe("2026-10-20 08:00")
    expect(dueOccurrence(job, { last_scheduled: "2026-10-20 08:00" }, at("2026-10-20 09:00"))).toBeNull()
  })

  test("calendar: never a slot before created", () => {
    const job = { every: "daily 08:00", expires: "2026-12-31", created: "2026-10-20 10:00" }
    expect(dueOccurrence(job, {}, at("2026-10-20 11:00"))).toBeNull()
    expect(fmt(dueOccurrence(job, {}, at("2026-10-21 08:01")))).toBe("2026-10-21 08:00")
  })

  test("calendar: weekdays skip the weekend", () => {
    const job = { every: "weekdays 08:00", expires: "2026-12-31", created: "2026-10-01 00:00" }
    // Sunday 2026-10-25: the latest weekday slot is Friday's.
    expect(fmt(dueOccurrence(job, {}, at("2026-10-25 12:00")))).toBe("2026-10-23 08:00")
    expect(dueOccurrence(job, { last_scheduled: "2026-10-23 08:00" }, at("2026-10-25 12:00"))).toBeNull()
  })

  test("interval: from the last run, else from created", () => {
    const job = { every: "30m", expires: "2026-12-31", created: "2026-10-20 10:00" }
    expect(dueOccurrence(job, {}, at("2026-10-20 10:20"))).toBeNull()
    expect(fmt(dueOccurrence(job, {}, at("2026-10-20 10:30")))).toBe("2026-10-20 10:30")
    expect(dueOccurrence(job, { last_run: "2026-10-20 10:30" }, at("2026-10-20 10:55"))).toBeNull()
  })
})

describe("nextRunText", () => {
  test("one-shot, done, expired, calendar", () => {
    const now = at("2026-10-20 12:00")
    expect(nextRunText({ when: "2026-10-21 08:00", expires: "2026-10-28" }, {}, now)).toBe("2026-10-21 08:00")
    expect(nextRunText({ when: "2026-10-20 08:00", expires: "2026-10-28" }, { last_scheduled: "2026-10-20 08:00" }, now)).toBe("done")
    expect(nextRunText({ when: "2026-10-01 08:00", expires: "2026-10-02" }, {}, now)).toBe("expired")
    expect(nextRunText({ every: "mon,thu 08:00", expires: "2026-12-31" }, {}, now)).toBe("2026-10-22 08:00")
  })
})

const VALID = `---
id: verify-410s
kind: spinuptui
when: 2026-10-21 08:00   # station local time
expires: 2026-10-28
created_by: test
---
incidents example.com --hours 48
`

describe("job files", () => {
  test("parse and validate a good file", () => {
    const { header, body } = parseJobText(VALID)
    expect(header.when).toBe("2026-10-21 08:00")
    expect(body).toBe("incidents example.com --hours 48")
    expect(validateJob(header, body, "verify-410s.md")).toEqual([])
  })

  test("problems are listed, not thrown", () => {
    const { header, body } = parseJobText(VALID.replace("kind: spinuptui", "kind: robot").replace("expires: 2026-10-28\n", ""))
    const problems = validateJob(header, body, "other.md")
    expect(problems).toContain("missing expires:")
    expect(problems.some((p) => p.startsWith("kind must be"))).toBe(true)
    expect(problems).toContain("file must be named verify-410s.md")
  })

  test("a spinuptui job can't start a tick", () => {
    const { header } = parseJobText(VALID)
    expect(validateJob(header, "scheduler tick --here")[0]).toMatch(/may not start a tick/)
  })

  test("both when and every, or neither, is invalid", () => {
    const { header, body } = parseJobText(VALID)
    expect(validateJob({ ...header, every: "30m" }, body)).toContain("give exactly one of when: or every:")
  })

  test("kind: codex is agent + codex", () => {
    expect(agentOf({ kind: "codex" })).toBe("codex")
    expect(agentOf({ kind: "agent" })).toBe("claude")
    expect(agentOf({ kind: "agent", agent: "codex" })).toBe("codex")
    expect(agentOf({ kind: "script" })).toBeNull()
  })

  test("an unclosed header is an error", () => {
    expect(() => parseJobText("---\nid: x\n")).toThrow(/not closed/)
  })
})

describe("splitArgs / quoteArg", () => {
  test("shell-like splitting without expansion", () => {
    expect(splitArgs(`ssh-exec example.com -- 'curl -sI https://example.com/$x'`)).toEqual(["ssh-exec", "example.com", "--", "curl -sI https://example.com/$x"])
    expect(splitArgs(`a "b \\"c\\"" d\\ e ''`)).toEqual(["a", 'b "c"', "d e", ""])
    expect(splitArgs("incidents --all\n  --hours 24")).toEqual(["incidents", "--all", "--hours", "24"])
    expect(() => splitArgs("a 'b")).toThrow(/unclosed/)
  })

  test("quoteArg round-trips through splitArgs", () => {
    const argv = ["ssh-exec", "example.com", "--", "grep -c ' 410 ' /var/log/x.log", "it's"]
    expect(splitArgs(argv.map(quoteArg).join(" "))).toEqual(argv)
  })
})

describe("units", () => {
  const p = { label: "com.spinuptui.scheduler", programArguments: ["/b/bun", "/b/spinuptui", "scheduler", "tick"], env: { PATH: "/b:/usr/bin", X: "a&b" } }

  test("the plist ticks on twelve calendar entries and at load", () => {
    const xml = renderPlist({ ...p, logPath: "/s/launchd.log" })
    expect(xml.match(/<key>Minute<\/key>/g)?.length).toBe(12)
    expect(xml).toContain("<integer>55</integer>")
    expect(xml).not.toContain("StartInterval</key>")
    expect(xml).toContain("<key>RunAtLoad</key><true/>")
    expect(xml).toContain("<string>a&amp;b</string>")
  })

  test("systemd units", () => {
    const u = renderSystemd(p)
    expect(u.service).toContain("ExecStart=/b/bun /b/spinuptui scheduler tick")
    expect(u.timer).toContain("OnCalendar=*:0/5")
    expect(u.timer).toContain("Persistent=true")
  })
})

describe("module jobs", () => {
  test("page when a job starts failing and when it recovers, not every run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"))
    const pages: string[] = []
    const results = [false, false, true, true]
    const decl = { id: "sentinel.tick", every: "10m", command: ["incidents", "--all"] }
    let now = at("2026-10-20 10:00")
    for (const _ of results) {
      const ok = results.shift()!
      results.push(ok) // keep the loop length; order is what matters
      await runModuleJobs([decl], {
        stateDir: dir,
        now,
        run: async () => ({ ok, output: ok ? "{}" : "boom" }),
        page: async (t) => (pages.push(t), "sent"),
      })
      now = new Date(now.getTime() + 10 * 60_000)
    }
    expect(pages.length).toBe(2)
    expect(pages[0]).toMatch(/failed/)
    expect(pages[1]).toMatch(/working again/)
  })

  test("not due yet means not run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"))
    let runs = 0
    const deps = { stateDir: dir, run: async () => (runs++, { ok: true, output: "" }), page: async () => "sent" }
    const decl = { id: "x.tick", every: "10m", command: ["modules"] }
    await runModuleJobs([decl], { ...deps, now: at("2026-10-20 10:00") })
    await runModuleJobs([decl], { ...deps, now: at("2026-10-20 10:05") })
    await runModuleJobs([decl], { ...deps, now: at("2026-10-20 10:10") })
    expect(runs).toBe(2)
  })

  test("a module job may not run scheduler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-"))
    const r = await runModuleJobs([{ id: "bad", every: "10m", command: ["scheduler", "tick"] }], {
      stateDir: dir,
      now: new Date(),
      run: async () => ({ ok: true, output: "" }),
      page: async () => "sent",
    })
    expect(r.ran).toEqual([])
    expect(r.errors[0]).toMatch(/can't run `scheduler`/)
  })
})

describe("summaryOf", () => {
  const job = (kind: string) => ({ name: "x.md", header: { kind }, body: "", problems: [] })
  test("agent: the SUMMARY paragraph", () => {
    expect(summaryOf(job("agent"), "noise\nSUMMARY: All good.\nStill summary.\n\n## Details")).toBe("All good.\nStill summary.")
  })
  test("spinuptui: a failed JSON result's message", () => {
    expect(summaryOf(job("spinuptui"), '→ progress\n{"ok":false,"reason":"x","message":"Kuma unreachable"}')).toBe("Kuma unreachable")
  })
  test("script: the tail", () => {
    expect(summaryOf(job("script"), Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n")).split("\n")[0]).toBe("l15")
  })
})

describe("flock", () => {
  test("a held lock can't be taken twice", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sched-")), "x.lock")
    const a = tryLock(path)
    expect(a).not.toBeNull()
    // Same process, different open file description: flock still excludes it.
    expect(tryLock(path)).toBeNull()
    a!.release()
    const b = tryLock(path)
    expect(b).not.toBeNull()
    b!.release()
  })
})

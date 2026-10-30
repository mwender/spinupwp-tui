import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dueOccurrence, fmt, nextRunText, parseEvery, parseWhen } from "./schedule.ts"
import { agentOf, parseJobText, splitArgs, validateJob } from "./schedulerJobs.ts"
import { quoteArg } from "./cliScheduler.ts"
import { renderPlist, renderSystemd } from "./schedulerInstall.ts"
import { runModuleJobs } from "./schedulerTick.ts"
import { agentCommand, BLOCKED_EXIT, outcomeOf, summaryOf } from "./schedulerRun.ts"
import { stillRunningHeartbeat } from "./heartbeat.ts"
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

// ---- late: ------------------------------------------------------------------------

import { lateGraceMs } from "./schedulerJobs.ts"
import { isTooLate } from "./schedulerTick.ts"

describe("late:", () => {
  test("values", () => {
    expect(lateGraceMs(undefined)).toBeNull()
    expect(lateGraceMs("run")).toBeNull()
    expect(lateGraceMs("skip")).toBe(15 * 60_000)
    expect(lateGraceMs("2h")).toBe(2 * 3_600_000)
    expect(lateGraceMs("45m")).toBe(45 * 60_000)
    expect(lateGraceMs("0m")).toBeUndefined()
    expect(lateGraceMs("later")).toBeUndefined()
  })

  test("validation names a bad value", () => {
    const { header, body } = parseJobText(VALID)
    expect(validateJob({ ...header, late: "sometime" }, body)[0]).toMatch(/late: is run, skip/)
    expect(validateJob({ ...header, late: "skip" }, body)).toEqual([])
  })

  test("skip only past the grace window; run never; intervals never", () => {
    const occ = at("2026-10-21 08:00")
    expect(isTooLate({ late: "skip" }, occ, at("2026-10-21 08:10"))).toBe(false)
    expect(isTooLate({ late: "skip" }, occ, at("2026-10-21 08:20"))).toBe(true)
    expect(isTooLate({ late: "2h" }, occ, at("2026-10-21 09:55"))).toBe(false)
    expect(isTooLate({ late: "2h" }, occ, at("2026-10-21 10:05"))).toBe(true)
    expect(isTooLate({}, occ, at("2026-10-22 08:00"))).toBe(false)
    expect(isTooLate({ late: "skip", every: "30m" }, occ, at("2026-10-21 12:00"))).toBe(false)
    expect(isTooLate({ late: "skip", every: "daily 08:00" }, occ, at("2026-10-21 12:00"))).toBe(true)
  })
})

// ---- the station claim, against real git ------------------------------------------

import { readFileSync as readFile, existsSync as exists, writeFileSync as writeFile } from "node:fs"
import { spawn } from "./spawn.ts"
import { decideClaim, removeClaim, writeClaim, readClaim } from "./schedulerGit.ts"
import type { Source } from "./schedulerJobs.ts"

async function sh(cwd: string, ...cmd: string[]) {
  const p = spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(p.stdout).text()
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`)
  return out.trim()
}

async function twoStations() {
  for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" })) process.env[k] = v
  const root = mkdtempSync(join(tmpdir(), "claim-"))
  await sh(root, "git", "init", "-q", "--bare", "-b", "main", "remote.git")
  await sh(root, "git", "clone", "-q", "remote.git", "a")
  await sh(join(root, "a"), "git", "commit", "-q", "--allow-empty", "-m", "init")
  await sh(join(root, "a"), "git", "push", "-q", "-u", "origin", "main")
  await sh(root, "git", "clone", "-q", "remote.git", "b")
  const src = (dir: string, queueOnly = false): Source => ({ name: "followups", path: join(root, dir), gitRoot: join(root, dir), git: true, queueOnly })
  return { root, a: src("a"), b: src("b"), src }
}

describe("station claim", () => {
  test("first tick claims; a rival backs off, even when it hadn't pulled the claim yet", async () => {
    const { a, b } = await twoStations()
    expect(await decideClaim(a, "mini")).toEqual({ run: true, claimed: true })
    expect(await decideClaim(a, "mini")).toEqual({ run: true })
    // b never pulled: its own claim's push is rejected, rolled back, and it
    // finds mini's claim on the pull.
    const d = await decideClaim(b, "nas")
    expect(d.run).toBe(false)
    expect(d.run === false && d.holder).toBe("mini")
    expect(readClaim(b)).toBe("mini")
  })

  test("a failed takeover restores the holder's claim and keeps the user's own work", async () => {
    const { a, b } = await twoStations()
    await decideClaim(a, "mini")
    await sh(b.path, "git", "pull", "-q")
    // mini moves on, so b is behind when it tries to take over.
    writeFile(join(a.path, "notes.md"), "x\n")
    await sh(a.path, "git", "add", "notes.md")
    await sh(a.path, "git", "commit", "-q", "-m", "notes")
    await sh(a.path, "git", "push", "-q")
    writeFile(join(b.path, "mine.txt"), "uncommitted work\n")
    const r = await writeClaim(b, "nas", "station: nas runs followups")
    expect(r).toMatch(/push rejected/)
    expect(readClaim(b)).toBe("mini")
    expect(readFile(join(b.path, "mine.txt"), "utf8")).toBe("uncommitted work\n")
    // After the rollback and pull, a deliberate claim succeeds.
    expect(await writeClaim(b, "nas", "station: nas runs followups")).toBeNull()
    await sh(a.path, "git", "pull", "-q")
    const d = await decideClaim(a, "mini")
    expect(d.run === false && d.holder).toBe("nas")
  })

  test("release hands the source to the next station; a queue-only machine never claims", async () => {
    const { a, b, src } = await twoStations()
    await decideClaim(a, "mini")
    expect(await removeClaim(a, "station: mini releases followups")).toBeNull()
    expect(exists(join(a.path, ".scheduler", "station"))).toBe(false)
    // mini marked itself queue-only on release, so its next tick doesn't re-claim.
    const again = await decideClaim(src("a", true), "mini")
    expect(again.run).toBe(false)
    await sh(b.path, "git", "pull", "-q")
    expect(await decideClaim(b, "nas")).toEqual({ run: true, claimed: true })
  })
})

// ---- extend ----------------------------------------------------------------------

import { mkdirSync } from "node:fs"
import { addPeriod, extendJob, newExpiry, setHeaderValue } from "./schedulerExtend.ts"
import { fmtDate, parseDate } from "./schedule.ts"

describe("extend", () => {
  const day = (s: string) => parseDate(s)

  test("periods, clamped to the month's last day", () => {
    expect(fmtDate(addPeriod(day("2026-10-29"), "1y"))).toBe("2027-10-29")
    expect(fmtDate(addPeriod(day("2028-02-29"), "1y"))).toBe("2029-02-28")
    expect(fmtDate(addPeriod(day("2026-01-31"), "1m"))).toBe("2026-02-28")
    expect(fmtDate(addPeriod(day("2026-12-30"), "2w"))).toBe("2027-01-13")
    expect(fmtDate(addPeriod(day("2026-10-29"), "30d"))).toBe("2026-11-28")
    expect(() => addPeriod(day("2026-10-29"), "0d")).toThrow(/--by/)
    expect(() => addPeriod(day("2026-10-29"), "1q")).toThrow(/--by/)
  })

  test("--by counts from the expiry, or from today once it has passed", () => {
    expect(newExpiry("2026-11-06", { by: "1y" }, at("2026-10-29 09:00"))).toBe("2027-11-06")
    expect(newExpiry("2026-10-01", { by: "1y" }, at("2026-10-29 09:00"))).toBe("2027-10-29")
    expect(newExpiry("2026-11-06", { date: "2027-01-05" }, at("2026-10-29 09:00"))).toBe("2027-01-05")
  })

  test("only the expires: line changes, comment kept", () => {
    const text = "---\nid: x\nexpires: 2026-10-28   # stop after the audit\nkind: script\n---\necho hi\n"
    expect(setHeaderValue(text, "expires", "2027-10-28")).toBe("---\nid: x\nexpires: 2027-10-28   # stop after the audit\nkind: script\n---\necho hi\n")
    expect(() => setHeaderValue("---\nid: x\n---\nbody", "expires", "2027-01-01")).toThrow(/no expires/)
    // A body line that looks like a header isn't touched.
    expect(setHeaderValue("---\nexpires: 2026-01-01\n---\nexpires: keep\n", "expires", "2027-01-01")).toBe("---\nexpires: 2027-01-01\n---\nexpires: keep\n")
  })

  const job = "---\nid: nightly\nkind: script\nevery: daily 22:00\nexpires: 2026-11-06\ncreated: 2026-10-20 09:00\ncreated_by: test\n---\necho hi\n"

  test("a local source: rewritten in place, and an earlier date is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "extend-"))
    mkdirSync(join(dir, "jobs"))
    writeFile(join(dir, "jobs", "nightly.md"), job)
    const s: Source = { name: "local", path: dir, gitRoot: null, git: false, queueOnly: false }
    const r = await extendJob(s, "nightly", { by: "1y" }, { now: at("2026-10-29 09:00") })
    expect(r).toMatchObject({ ok: true, from: "2026-11-06", to: "2027-11-06", pushed: null })
    expect(readFile(join(dir, "jobs", "nightly.md"), "utf8")).toBe(job.replace("2026-11-06", "2027-11-06"))
    expect(await extendJob(s, "nightly", { date: "2027-01-01" })).toMatchObject({ ok: false, reason: "not_later" })
    expect(await extendJob(s, "nope", { by: "1y" })).toMatchObject({ ok: false, reason: "unknown_job" })
  })

  test("a git source: one commit, pushed, seen by the other clone", async () => {
    const { a, b } = await twoStations()
    mkdirSync(join(a.path, "jobs"))
    writeFile(join(a.path, "jobs", "nightly.md"), job)
    await sh(a.path, "git", "add", "jobs")
    await sh(a.path, "git", "commit", "-q", "-m", "add")
    await sh(a.path, "git", "push", "-q")
    // Queued from the other clone, which hasn't pulled the job yet.
    const r = await extendJob(b, "nightly", { by: "1y" }, { now: at("2026-10-29 09:00") })
    expect(r).toMatchObject({ ok: true, to: "2027-11-06", pushed: true })
    expect(await sh(b.path, "git", "log", "-1", "--format=%s")).toBe("job: extend nightly to 2027-11-06")
    await sh(a.path, "git", "pull", "-q")
    expect(readFile(join(a.path, "jobs", "nightly.md"), "utf8")).toContain("expires: 2027-11-06")
  })
})

// ---- /jobs on the pager ------------------------------------------------------------

import { extendReply, jobsReply } from "../modules/scheduler.ts"

describe("/jobs", () => {
  const write = (dir: string, id: string, schedule: string, expires: string) =>
    writeFile(join(dir, `${id}.md`), `---\nid: ${id}\nkind: script\n${schedule}\nexpires: ${expires}\ncreated: 2026-10-01 09:00\ncreated_by: test\n---\necho hi\n`)

  test("lists jobs by expiry, flags the soon ones, and offers Extend on recurring ones", async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "jobs-cfg-"))
    process.env.SPINUPTUI_HOME = mkdtempSync(join(tmpdir(), "jobs-home-"))
    const jobs = join(process.env.SPINUPTUI_HOME, "scheduler", "jobs")
    mkdirSync(jobs, { recursive: true })
    write(jobs, "nightly", "every: daily 22:00", "2026-11-06")
    write(jobs, "audit", "when: 2026-10-30 09:00", "2026-11-02")
    write(jobs, "longterm", "every: weekdays 08:00", "2028-10-29")
    write(jobs, "ancient", "every: daily 08:00", "2026-01-01")
    const now = at("2026-10-29 12:00")
    const r = await jobsReply({ now, pull: false })
    expect(r.html).toBe(true)
    expect(r.text).toContain("</b> (3)")
    const order = ["audit", "nightly", "longterm"].map((id) => r.text.indexOf(`<b>${id}</b>`))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(r.text).toContain("⚠️ <b>nightly</b>\nExpires Nov 6 (in 8 days)\nscript · daily 22:00 · next tonight 22:00")
    expect(r.text).toContain("⚠️ <b>audit</b>\nExpires Nov 2 (in 4 days)\nscript · once, tomorrow 09:00")
    expect(r.text).toContain("<b>longterm</b>\nExpires Oct 29, 2028\nscript · weekdays 08:00 · next tomorrow 08:00")
    expect(r.text).toContain("1 finished or long-expired not shown.")
    // A one-shot isn't offered a year of nothing.
    expect(r.buttons).toEqual([[{ text: "Extend nightly 1 year", action: "scheduler.extend", payload: { source: "local", id: "nightly", from: "2026-11-06" } }]])

    const done = await extendReply(r.buttons![0]![0]!.payload, now)
    expect(done.text).toBe("✅ Extended nightly: it now expires 2027-11-06 (was 2026-11-06).")
    // The same button again (say, from an older /jobs reply) doesn't stack a second year.
    expect((await extendReply(r.buttons![0]![0]!.payload, now)).text).toMatch(/^Couldn't extend nightly: nightly already expires 2027-11-06/)
    delete process.env.SPINUPTUI_HOME
  })
})

describe("blocked", () => {
  test("an agent that exits 0 saying it's blocked did no work", () => {
    expect(outcomeOf(true, 0, false, "SUMMARY: login lapsed.\nSTATUS: blocked\nNeeds a re-login.")).toBe("blocked")
    expect(outcomeOf(true, 0, false, "SUMMARY: all fine.\n\nThe status: blocked queue is empty.")).toBe("ok")
  })

  test("a script says so with its exit code", () => {
    expect(outcomeOf(false, BLOCKED_EXIT, false, "")).toBe("blocked")
    expect(outcomeOf(false, 1, false, "")).toBe("failed")
    expect(outcomeOf(false, 0, false, "STATUS: blocked")).toBe("ok")
  })

  test("a lapsed login and a timeout keep their own statuses", () => {
    expect(outcomeOf(true, 1, false, "Please run /login")).toBe("auth")
    expect(outcomeOf(true, null, true, "working")).toBe("timeout")
    expect(outcomeOf(true, 1, false, "boom")).toBe("failed")
  })

  test("a blocked one-shot isn't done", () => {
    const job = { when: "2026-10-20 08:00", expires: "2026-10-30" }
    const now = at("2026-10-21 08:00")
    expect(nextRunText(job, { last_scheduled: "2026-10-20 08:00", last_status: "blocked" }, now)).toBe("blocked")
    expect(nextRunText(job, { last_scheduled: "2026-10-20 08:00", last_status: "ok" }, now)).toBe("done")
    // It waits for the operator: a blocked run doesn't retry by itself.
    expect(dueOccurrence(job, { last_scheduled: "2026-10-20 08:00", last_status: "blocked" }, now)).toBeNull()
  })

  test("a module job pages once when blocked, and again when it recovers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blocked-"))
    const pages: string[] = []
    const step = (result: { ok: boolean; output: string; blocked?: boolean }, minute: string) =>
      runModuleJobs([{ id: "t", every: "5m", command: ["x"] }], { stateDir: dir, now: at(`2026-10-20 10:${minute}`), run: async () => result, page: async (t) => (pages.push(t), "sent") })
    await step({ ok: false, output: "login", blocked: true }, "00")
    await step({ ok: false, output: "login", blocked: true }, "05")
    await step({ ok: true, output: "" }, "10")
    expect(pages.length).toBe(2)
    expect(pages[0]).toContain("blocked")
    expect(pages[1]).toContain("working again")
  })
})

describe("the agent adapter", () => {
  test("carries the always-deny list and options, for any caller", () => {
    const cmd = agentCommand({ agent: "claude", prompt: "p", workdir: "/w", allow: "Read", addDirs: "/a,/b", model: "m" }, { PATH: `/bin:${process.env.PATH}` })
    if (typeof cmd === "string") return // no claude here; the string is the reason
    expect(cmd).toContain("--disallowedTools")
    expect(cmd.filter((a) => a === "--add-dir").length).toBe(2)
  })

  test("says why when the binary is missing", () => {
    expect(agentCommand({ agent: "codex", prompt: "p", workdir: "/w" }, { PATH: "/nonexistent" })).toBe("codex not found on PATH")
  })
})

describe("a dispatcher tick that finds the lock held", () => {
  test("tells Kuma the station is alive, unless it can't page", () => {
    expect(stillRunningHeartbeat(null)).toEqual({ status: "up", msg: "tick still running" })
    expect(stillRunningHeartbeat("Beacon's last page failed").status).toBe("down")
  })

  test("pings and records itself; a manual one doesn't", async () => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "stilltick-"))
    const { schedulerStateDir, readLastTick } = await import("./schedulerJobs.ts")
    const { saveConfig } = await import("../config.ts")
    const { tick } = await import("./schedulerTick.ts")
    const pings: string[] = []
    const server = Bun.serve({ port: 0, fetch: (r) => (pings.push(r.url), Response.json({ ok: true })) })
    try {
      await saveConfig({
        scheduler: { heartbeat: { url: `http://localhost:${server.port}/api/push/x`, setAt: "now" } },
        beacon: { channels: { pager: { type: "telegram", botToken: "1:a", chatId: "2" } } },
      })
      const lock = tryLock(join(schedulerStateDir(), "tick.lock"))!
      expect(await tick({ via: "manual" })).toMatchObject({ skipped: "locked" })
      expect(pings.length).toBe(0)
      expect(await tick({ via: "dispatcher" })).toMatchObject({ skipped: "locked" })
      lock.release()
      expect(pings.length).toBe(1)
      expect(pings[0]).toContain("still")
      expect(readLastTick()).toMatchObject({ stillRunning: true, via: "dispatcher", heartbeat: { ok: true } })
    } finally {
      server.stop(true)
    }
  })
})

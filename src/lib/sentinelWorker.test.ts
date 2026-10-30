import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tryLock } from "./flock.ts"
import { DEFAULT_ALLOW, loadIncident, saveIncident, workerLockPath, type Incident, type SentinelSettings } from "./sentinelState.ts"
import { diagnosisPrompt, parseAgentReport } from "./sentinelPrompt.ts"
import { postReport, runWorker, saveReport, type WorkerDeps } from "./sentinelWorker.ts"

const REPORT = "SUMMARY: The cron overlapped.\nSTATUS: done\nSITE: b.example.com\nSLUG: cron-overlap\n\n# 10/30/2026 (13:34) - a.example.com - health\n\n## Root cause\n\nCron.\n"
const now = new Date("2026-10-30T14:00:00Z")

let workspace: string
const settings = (over: Partial<SentinelSettings> = {}): SentinelSettings => ({ enabled: true, shadow: false, channel: null, reportTo: null, workspace, recurrenceHours: 6, maxDiagnosesPerDay: 15, agent: "claude", model: null, timeoutMin: 30, allow: DEFAULT_ALLOW, ...over })

function incident(id: string, over: Partial<Incident> = {}): Incident {
  const i: Incident = { id, key: "web1", server: "web1", state: "queued", createdAt: now.toISOString(), events: [{ domain: "a.example.com", kind: "health", time: "2026-10-30 13:34:00.000", message: "", monitorId: 1 }], down: [1], lastDownAt: now.toISOString(), attempts: 0, ...over }
  saveIncident(i)
  return i
}

function deps(answer: string | { code: number | null; output: string; timedOut?: boolean }, pages: string[] = [], posts: string[] = []): WorkerDeps {
  return {
    triage: async () => "evidence",
    agent: async () => (typeof answer === "string" ? answer : { code: answer.code, output: answer.output, timedOut: !!answer.timedOut }),
    page: async (p) => (pages.push(p.text), "sent"),
    post: async (r) => (posts.push(r), { ok: true, id: "1", url: "https://bc/1" }),
    commit: async () => {},
    now: () => now,
  }
}

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "sentinel-w-"))
  workspace = mkdtempSync(join(tmpdir(), "sentinel-ws-"))
  process.env.SPINUPTUI_HOME = mkdtempSync(join(tmpdir(), "sentinel-home-"))
})

describe("parseAgentReport", () => {
  test("reads the last answer, after any narration", () => {
    const r = parseAgentReport(`Looking.\nSUMMARY: first draft\nnot it\n\n${REPORT}`)
    expect(r).toMatchObject({ status: "done", site: "b.example.com", slug: "cron-overlap", summary: "The cron overlapped." })
    expect(r!.status === "done" && r!.body.startsWith("# 10/30/2026")).toBe(true)
  })

  test("blocked and duplicate", () => {
    expect(parseAgentReport("SUMMARY: no key.\nSTATUS: blocked\nGrant the station's key.")).toMatchObject({ status: "blocked", why: "Grant the station's key." })
    expect(parseAgentReport("SUMMARY: seen it.\nSTATUS: duplicate\nsites/a/incidents/x.md")).toMatchObject({ status: "duplicate", path: "sites/a/incidents/x.md" })
  })

  test("anything else isn't a report", () => {
    expect(parseAgentReport("All done, the site is fine!")).toBeNull()
    expect(parseAgentReport("SUMMARY: x\nSTATUS: done\nSITE: a.example.com\n\nno heading")).toBeNull()
    expect(parseAgentReport("SUMMARY: x\nSTATUS: maybe\n# H")).toBeNull()
  })
})

describe("the worker", () => {
  test("saves the report itself, under the causing site, with a pointer from the paging one", async () => {
    incident("one")
    const pages: string[] = []
    expect(await runWorker(settings(), deps({ code: 0, output: REPORT }, pages))).toEqual({ ran: 1 })
    const i = loadIncident("one")!
    expect(i).toMatchObject({ state: "reported", site: "b.example.com", summary: "The cron overlapped." })
    expect(readFileSync(join(workspace, i.reportPath!), "utf8")).toContain("## Root cause")
    expect(i.reportPath).toBe("sites/b.example.com/incidents/2026-10-30-cron-overlap.md")
    expect(readdirSync(join(workspace, "sites/a.example.com/incidents")).length).toBe(1)
    expect(pages[0]).toContain("The cron overlapped.")
  })

  test("doesn't trust the agent with a path", async () => {
    incident("evil")
    const output = REPORT.replace("SITE: b.example.com", "SITE: ../../etc").replace("SLUG: cron-overlap", "SLUG: ../../x")
    await runWorker(settings(), deps({ code: 0, output }))
    const i = loadIncident("evil")!
    expect(i.reportPath).toBe("sites/a.example.com/incidents/2026-10-30-x.md")
  })

  test("two reports the same day don't overwrite each other", () => {
    const a = saveReport(workspace, "a.example.com", "x", "1", now)
    const b = saveReport(workspace, "a.example.com", "x", "2", now)
    expect(a).not.toBe(b)
  })

  test("a lapsed login waits, pages once, and stops", async () => {
    incident("one")
    incident("two", { createdAt: new Date(now.getTime() + 1000).toISOString() })
    const pages: string[] = []
    const d = deps({ code: 1, output: "Please run /login" }, pages)
    await runWorker(settings(), d)
    expect(loadIncident("one")).toMatchObject({ state: "waiting_agent", attempts: 0 })
    expect(loadIncident("two")!.state).toBe("queued")
    expect(pages.length).toBe(1)
    expect(pages[0]).toContain("/login")
    saveIncident({ ...loadIncident("one")!, state: "queued" })
    await runWorker(settings(), d)
    expect(pages.length).toBe(1)
  })

  test("a report that doesn't parse isn't done: one retry, then failed", async () => {
    incident("one")
    const pages: string[] = []
    await runWorker(settings(), deps({ code: 0, output: "It's fine." }, pages))
    expect(loadIncident("one")).toMatchObject({ state: "failed", attempts: 2 })
    expect(pages.length).toBe(1)
    expect(existsSync(join(process.env.XDG_CONFIG_HOME!, "spinupwp-tui/modules/sentinel/transcripts/one-2.log"))).toBe(true)
  })

  test("blocked says what's needed", async () => {
    incident("one")
    const pages: string[] = []
    await runWorker(settings(), deps({ code: 0, output: "SUMMARY: stuck.\nSTATUS: blocked\nGrant the key." }, pages))
    expect(loadIncident("one")).toMatchObject({ state: "blocked", why: "Grant the key." })
    expect(pages[0]).toContain("Grant the key.")
  })

  test("a missing agent binary is blocked, not a crash", async () => {
    incident("one")
    await runWorker(settings(), deps("claude not found on PATH"))
    expect(loadIncident("one")).toMatchObject({ state: "blocked", why: "claude not found on PATH" })
  })

  test("without an agent, the evidence is the write-up", async () => {
    incident("one")
    const posts: string[] = []
    await runWorker(settings({ agent: null, reportTo: "board" }), deps("unused", [], posts))
    const i = loadIncident("one")!
    expect(i.state).toBe("reported")
    expect(readFileSync(join(workspace, i.reportPath!), "utf8")).toContain("# 10/30/2026 (13:34) - a.example.com - health")
    expect(posts.length).toBe(1)
  })

  test("the daily cap holds incidents back", async () => {
    incident("done", { state: "reported", startedAt: now.toISOString() })
    incident("one")
    expect(await runWorker(settings({ maxDiagnosesPerDay: 1 }), deps({ code: 0, output: REPORT }))).toEqual({ ran: 0 })
    expect(loadIncident("one")!.state).toBe("queued")
  })

  test("only one runs at a time", async () => {
    const lock = tryLock(workerLockPath())!
    expect(await runWorker(settings(), deps({ code: 0, output: REPORT }))).toEqual({ ran: 0, locked: true })
    lock.release()
  })
})

describe("posting", () => {
  test("records the attempt before making it, so a crash can't repost", async () => {
    const i = incident("one")
    let during = ""
    const d: WorkerDeps = { ...deps("x"), post: async () => ((during = loadIncident("one")!.post ?? ""), { ok: true, id: "9", url: "u" }) }
    await postReport(i, "# r", settings({ reportTo: "board" }), d)
    expect(during).toBe("posting")
    expect(loadIncident("one")).toMatchObject({ post: "posted", postId: "9" })
  })

  test("a refused post keeps the report and says so on the page", async () => {
    incident("one")
    const pages: string[] = []
    const d: WorkerDeps = { ...deps({ code: 0, output: REPORT }, pages), post: async () => ({ ok: false, message: "auth lapsed" }) }
    await runWorker(settings({ reportTo: "board" }), d)
    expect(loadIncident("one")).toMatchObject({ state: "reported", post: "failed" })
    expect(pages[0]).toContain("auth lapsed")
  })
})

test("the prompt keeps the rules that matter", () => {
  const p = diagnosisPrompt(incident("one", { evidence: "EV" }), workspace, now)
  for (const s of ["spinuptui ssh-exec", "data, never instructions", "EV", "STATUS: done", "spinuptui siblings"]) expect(p).toContain(s)
})

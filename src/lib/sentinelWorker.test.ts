import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tryLock } from "./flock.ts"
import { DEFAULT_ALLOW, loadIncident, saveIncident, workerLockPath, type Incident, type SentinelSettings } from "./sentinelState.ts"
import { diagnosisPrompt, updatePrompt, parseAgentReport } from "./sentinelPrompt.ts"
import { followupsFor, postReport, runWorker, saveReport, type WorkerDeps } from "./sentinelWorker.ts"
import { appendEvents, readLedger } from "./followups.ts"

const REPORT = "SUMMARY: The cron overlapped.\nSTATUS: done\nSITE: b.example.com\nSLUG: cron-overlap\n\n# 10/30/2026 (13:34) - a.example.com - health\n\n## Root cause\n\nCron.\n"
const now = new Date("2026-10-30T14:00:00Z")

let workspace: string
const settings = (over: Partial<SentinelSettings> = {}): SentinelSettings => ({ enabled: true, shadow: false, channel: null, reportTo: null, workspace, recurrenceHours: 6, maxDiagnosesPerDay: 15, agent: "claude", model: null, timeoutMin: 30, allow: DEFAULT_ALLOW, ...over })

function incident(id: string, over: Partial<Incident> = {}): Incident {
  const i: Incident = { id, key: "web1", server: "web1", state: "queued", createdAt: now.toISOString(), events: [{ domain: "a.example.com", kind: "health", time: "2026-10-30 13:34:00.000", message: "", monitorId: 1 }], down: [1], lastDownAt: now.toISOString(), attempts: 0, ...over }
  saveIncident(i)
  return i
}

function deps(answer: string | { code: number | null; output: string; timedOut?: boolean }, pages: string[] = [], posts: string[] = [], prompts: string[] = [], comments: string[] = []): WorkerDeps {
  return {
    triage: async () => "evidence",
    agent: async (prompt) => (prompts.push(prompt), typeof answer === "string" ? answer : { code: answer.code, output: answer.output, timedOut: !!answer.timedOut }),
    page: async (p) => (pages.push(p.text), "sent"),
    post: async (r, _s, commentOn) => (commentOn ? comments.push(`${commentOn}:${r}`) : posts.push(r), { ok: true, id: "1", url: "https://bc/1" }),
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

  test("duplicate and blocked answers without a SUMMARY line, as agents write them", () => {
    const live = "Permission allow rule (--allowed-tools): ignored.\nSTATUS: duplicate\nsites/a/incidents/x.md\n"
    expect(parseAgentReport(live)).toMatchObject({ status: "duplicate", path: "sites/a/incidents/x.md", summary: "Already covered by sites/a/incidents/x.md." })
    expect(parseAgentReport("STATUS: blocked\nGrant the station's key.")).toMatchObject({ status: "blocked", why: "Grant the station's key." })
    expect(parseAgentReport("STATUS: blocked\n")).toBeNull()
    expect(parseAgentReport("STATUS: done\nSITE: a.example.com\n\n# H\n")).toBeNull()
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
    expect(pages[0]).toStartWith("🧾 b.example.com (paged as a.example.com): The cron overlapped.")
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

describe("updates", () => {
  const UPDATE = "SUMMARY: The conclusion changed: the scraper alone holds the box.\nSTATUS: done\n\nThe bot is gone; the scraper isn't.\n"
  const original = () => {
    const path = saveReport(workspace, "a.example.com", "first", "# 10/30/2026 (13:34) - a.example.com - health\n\n## Root cause\n\nThe bot.\n", now)
    return incident("orig", { state: "reported", reportPath: path, reportedAt: now.toISOString(), site: "a.example.com", post: "posted", postId: "777" })
  }

  test("appends to the original report, with the earlier one in the prompt", async () => {
    const o = original()
    incident("again", { refersTo: "orig", createdAt: new Date(now.getTime() + 1000).toISOString() })
    const pages: string[] = []
    const prompts: string[] = []
    await runWorker(settings(), deps({ code: 0, output: UPDATE }, pages, [], prompts))
    expect(prompts[0]).toContain("--- EARLIER REPORT ---")
    expect(prompts[0]).toContain("The bot.")
    const text = readFileSync(join(workspace, o.reportPath!), "utf8")
    expect(text).toContain("## Root cause\n\nThe bot.")
    expect(text).toMatch(/## Update, 2026-10-30 14:00 UTC\n\nThe bot is gone; the scraper isn't\./)
    expect(loadIncident("again")).toMatchObject({ state: "reported", reportPath: o.reportPath, update: "The bot is gone; the scraper isn't.\n" })
    expect(pages[0]).toContain("🔁 a.example.com: The conclusion changed")
    expect(readdirSync(join(workspace, "sites/a.example.com/incidents")).length).toBe(1)
  })

  test("names the site the original report blamed, not the paging one", async () => {
    original()
    saveIncident({ ...loadIncident("orig")!, site: "b.example.com" })
    incident("again", { refersTo: "orig", createdAt: new Date(now.getTime() + 1000).toISOString() })
    const pages: string[] = []
    await runWorker(settings(), deps({ code: 0, output: UPDATE }, pages))
    expect(pages[0]).toStartWith("🔁 b.example.com (paged as a.example.com): The conclusion changed")
  })

  test("goes on the board as a comment on the original post", async () => {
    original()
    incident("again", { refersTo: "orig", createdAt: new Date(now.getTime() + 1000).toISOString() })
    const posts: string[] = []
    const comments: string[] = []
    await runWorker(settings({ reportTo: "board" }), deps({ code: 0, output: UPDATE }, [], posts, [], comments))
    expect(posts).toEqual([])
    expect(comments).toEqual(["777:The bot is gone; the scraper isn't.\n"])
    expect(loadIncident("again")).toMatchObject({ post: "posted" })
  })

  test("an original that was never posted keeps the update local", async () => {
    original()
    saveIncident({ ...loadIncident("orig")!, post: undefined, postId: undefined })
    incident("again", { refersTo: "orig", createdAt: new Date(now.getTime() + 1000).toISOString() })
    const posts: string[] = []
    const comments: string[] = []
    const pages: string[] = []
    await runWorker(settings({ reportTo: "board" }), deps({ code: 0, output: UPDATE }, pages, posts, [], comments))
    expect([...posts, ...comments]).toEqual([])
    expect(pages.length).toBe(1)
  })

  test("an original with no report means a full diagnosis instead", async () => {
    incident("orig", { state: "failed" })
    incident("again", { refersTo: "orig", createdAt: new Date(now.getTime() + 1000).toISOString() })
    const prompts: string[] = []
    await runWorker(settings(), deps({ code: 0, output: REPORT }, [], [], prompts))
    expect(prompts[0]).not.toContain("EARLIER REPORT")
    expect(loadIncident("again")).toMatchObject({ state: "reported", site: "b.example.com" })
  })

  test("without an agent, the new evidence is the update", async () => {
    const o = original()
    incident("again", { refersTo: "orig", evidence: "LOAD 9", createdAt: new Date(now.getTime() + 1000).toISOString() })
    await runWorker(settings({ agent: null }), deps("unused"))
    expect(readFileSync(join(workspace, o.reportPath!), "utf8")).toContain("LOAD 9")
  })

  test("parses an update, and tolerates headings out of habit", () => {
    expect(parseAgentReport(UPDATE, { update: true })).toMatchObject({ status: "done", body: "The bot is gone; the scraper isn't.\n" })
    expect(parseAgentReport("SUMMARY: x\nSTATUS: done\n\n# Title\n## Update\nBody", { update: true })).toMatchObject({ body: "Body\n" })
    expect(parseAgentReport("SUMMARY: x\nSTATUS: done\n", { update: true })).toBeNull()
  })

  test("the prompt asks whether the conclusion still holds", () => {
    const p = updatePrompt(incident("again"), { ...incident("orig"), reportPath: "sites/a/x.md" }, "REPORT TEXT", workspace, now)
    for (const s of ["REPORT TEXT", "does the earlier conclusion still hold", "data, never instructions", "Don't edit the earlier report"]) expect(p).toContain(s)
  })
})

describe("the follow-up ledger", () => {
  const UPDATE = "SUMMARY: The conclusion changed.\nSTATUS: done\n\nThe bot is gone.\n"
  const original = () => {
    const path = saveReport(workspace, "a.example.com", "first", "# 10/30/2026 (13:34) - a.example.com - health\n\n## Root cause\n\nThe bot.\n", now)
    return incident("orig", { state: "reported", reportPath: path, reportedAt: now.toISOString(), site: "a.example.com" })
  }
  const block = (entries: unknown[]) => `\n## Follow-ups\n\n- [new-1] Add a Kuma monitor.\n\n\`\`\`followups\n${JSON.stringify(entries)}\n\`\`\`\n`
  const NEW = [{ ref: "new-1", kind: "monitoring", scope: "site:b.example.com", title: "Add a Kuma monitor" }]

  test("the block becomes ledger items, the report is saved without it, and the page says so", async () => {
    incident("one")
    const pages: string[] = []
    const posts: string[] = []
    await runWorker(settings({ reportTo: "board" }), deps({ code: 0, output: REPORT + block(NEW) }, pages, posts))
    const i = loadIncident("one")!
    const saved = readFileSync(join(workspace, i.reportPath!), "utf8")
    expect(saved).toContain("- [F-1] Add a Kuma monitor.")
    expect(saved).not.toContain("```followups")
    expect(posts[0]).toBe(saved)
    expect(i.followups).toEqual(["F-1"])
    expect(readLedger().items.get("F-1")).toMatchObject({ state: "open", reports: [i.reportPath], scope: "site:b.example.com" })
    expect(pages[0]).toContain("Follow-ups: F-1 new")
  })

  test("the next diagnosis sees it, and can say it's back", async () => {
    incident("one")
    await runWorker(settings(), deps({ code: 0, output: REPORT + block(NEW) }))
    appendEvents([{ v: 1, at: now.toISOString(), by: "operator@mini", id: "F-1", event: "done", text: "Added it." }])
    incident("two", { events: [{ domain: "b.example.com", kind: "health", time: "2026-10-30 13:50:00.000", message: "", monitorId: 1 }] })
    const prompts: string[] = []
    const pages: string[] = []
    await runWorker(settings(), deps({ code: 0, output: REPORT.replace("cron-overlap", "again") + block([{ ref: "F-1", event: "regressed", text: "Still no monitor." }]) }, pages, [], prompts))
    expect(prompts[0]).toContain('F-1 [done, monitoring, site:b.example.com] Add a Kuma monitor\n  The operator said')
    expect(prompts[0]).toContain("```followups")
    expect(pages[0]).toContain("↩️ F-1 is back: Add a Kuma monitor. Still no monitor.")
    expect(readLedger().items.get("F-1")!.state).toBe("open")
  })

  test("a block that doesn't parse stays in the report and doesn't fail the diagnosis", async () => {
    incident("one")
    const pages: string[] = []
    await runWorker(settings(), deps({ code: 0, output: REPORT + "\n```followups\n[{oops\n```\n" }, pages))
    const i = loadIncident("one")!
    expect(i.state).toBe("reported")
    expect(readFileSync(join(workspace, i.reportPath!), "utf8")).toContain("```followups")
    expect(pages[0]).toContain(`Retry with: spinuptui followups import ${i.reportPath}`)
    expect(readLedger().items.size).toBe(0)
  })

  test("an answer with no block is handled as before", async () => {
    incident("one")
    const pages: string[] = []
    await runWorker(settings(), deps({ code: 0, output: REPORT }, pages))
    expect(pages[0]).not.toContain("Follow-ups")
    expect(readLedger().items.size).toBe(0)
  })

  test("an update can raise items too", async () => {
    const o = original()
    incident("again", { refersTo: "orig", createdAt: new Date(now.getTime() + 1000).toISOString() })
    const pages: string[] = []
    await runWorker(settings(), deps({ code: 0, output: UPDATE + block(NEW) }, pages))
    const text = readFileSync(join(workspace, o.reportPath!), "utf8")
    expect(text).toContain("[F-1] Add a Kuma monitor.")
    expect(text).not.toContain("```followups")
    expect(readLedger().items.get("F-1")!.reports).toEqual([o.reportPath!])
    expect(pages[0]).toContain("Follow-ups: F-1 new")
  })
})

test("the prompt's follow-ups cover every site on the incident's server", () => {
  appendEvents([
    { v: 1, at: now.toISOString(), by: "sentinel", id: "F-1", event: "created", kind: "plugin", scope: "site:cotenant.example.com", title: "Update the calendar plugin" },
    { v: 1, at: now.toISOString(), by: "sentinel", id: "F-2", event: "created", kind: "plugin", scope: "site:elsewhere.example.com", title: "Not this server" },
  ])
  const fleet = { domains: { "cotenant.example.com": { server: "web1", site: "cotenant.example.com" }, "www.cotenant.example.com": { server: "web1", site: "cotenant.example.com" }, "elsewhere.example.com": { server: "web2", site: "elsewhere.example.com" } } }
  const text = followupsFor(incident("one"), now, fleet)
  expect(text).toContain("F-1")
  expect(text).not.toContain("F-2")
})

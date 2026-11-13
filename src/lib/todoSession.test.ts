import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppConfig } from "../config.ts"
import { fold, type TodoEvent } from "./todos.ts"
import { isTrusted, loadSessions, openTodoSession, pickWorkdir, reapTodoSessions, resumePrompt, sessionName, type ClaudeRunner, type ReapDeps } from "./todoSession.ts"

const NOW = new Date("2026-11-13T12:00:00Z")
const ev = (e: Record<string, unknown>) => ({ v: 1, by: "sentinel", at: "2026-11-12T08:41:00Z", ...e }) as TodoEvent

function setup(trusted = true) {
  const root = mkdtempSync(join(tmpdir(), "todo-session-"))
  const workspace = join(root, "sentinel")
  const local = join(root, "example.com")
  mkdirSync(workspace, { recursive: true })
  mkdirSync(local, { recursive: true })
  const claudeJson = join(root, "claude.json")
  writeFileSync(claudeJson, JSON.stringify({ projects: trusted ? { [root]: { hasTrustDialogAccepted: true } } : {} }))
  const cfg = { sentinel: { workspace }, localSites: { "1": { domain: "example.com", path: local } } } as unknown as AppConfig
  return { root, workspace, local, claudeJson, cfg, statePath: join(root, "sessions.json"), promptDir: join(root, "prompts") }
}

const items = fold([
  ev({ id: "T-1", event: "created", kind: "monitoring", scope: "server:web1.example.com", title: "Widen the fatal window", report: "sites/web1.example.com/incidents/a.md" }),
  ev({ id: "T-2", event: "created", kind: "nginx", scope: "site:example.com", title: "Block a crawler" }),
])

// A fake `claude`: records each call and answers like the real one.
function fakeClaude(opts: { live?: boolean; launch?: string } = {}) {
  const calls: { args: string[]; cwd: string }[] = []
  const runner: ClaudeRunner = {
    async run(args, cwd) {
      calls.push({ args, cwd })
      if (args[0] === "agents") return { code: 0, output: JSON.stringify([{ id: "abc123", sessionId: "sess-real", pid: opts.live ? 42 : undefined }]) }
      if (args[0] === "logs") return { code: 0, output: "Remote Control: \x1b[1mhttps://claude.ai/code/session_XYZ123\x1b[0m" }
      return { code: 0, output: opts.launch ?? "Session backgrounded · abc123" }
    },
    sleep: async () => {},
  }
  return { calls, runner }
}

describe("openTodoSession", () => {
  test("starts a named Remote Control session in Sentinel's folder and remembers it", async () => {
    const s = setup()
    const { calls, runner } = fakeClaude()
    const r = await openTodoSession(items.get("T-1")!, { ...s, now: NOW, runner })
    expect(r).toMatchObject({ ok: true, status: "started", record: { sessionId: "sess-real", url: "https://claude.ai/code/session_XYZ123", workdir: s.workspace } })
    const launch = calls.find((c) => c.args[0] === "--bg")!
    expect(launch.cwd).toBe(s.workspace)
    expect(launch.args).toContain("Samurai (T-1): Widen the fatal window")
    expect(launch.args.slice(launch.args.indexOf("--remote-control"), launch.args.indexOf("--remote-control") + 2)).toEqual(["--remote-control", "Samurai (T-1): Widen the fatal window"])
    const prompt = readFileSync(join(s.promptDir, "T-1.md"), "utf8")
    expect(prompt).toContain("todos comment T-1 --as claude")
    expect(prompt).toContain("sites/web1.example.com/incidents/a.md")
    expect(loadSessions(s.statePath)["T-1"]?.seenEvents).toBe(1)
  })

  test("shows the session when it's still running, without starting another", async () => {
    const s = setup()
    await openTodoSession(items.get("T-1")!, { ...s, now: NOW, runner: fakeClaude().runner })
    const { calls, runner } = fakeClaude({ live: true })
    const r = await openTodoSession(items.get("T-1")!, { ...s, now: NOW, runner })
    expect(r).toMatchObject({ ok: true, status: "running" })
    expect(calls.some((c) => c.args[0] === "--bg")).toBe(false)
  })

  test("resumes a stopped session and tells it what changed", async () => {
    const s = setup()
    await openTodoSession(items.get("T-1")!, { ...s, now: NOW, runner: fakeClaude().runner })
    const later = fold([...items.get("T-1")!.history, ev({ id: "T-1", event: "comment", by: "operator@x", at: "2026-11-13T10:00:00Z", text: "Done on #97 only" })])
    const { calls, runner } = fakeClaude()
    const r = await openTodoSession(later.get("T-1")!, { ...s, now: NOW, runner })
    expect(r).toMatchObject({ ok: true, status: "resumed" })
    const launch = calls.find((c) => c.args[0] === "--bg")!
    expect(launch.args.slice(launch.args.indexOf("--resume"), launch.args.indexOf("--resume") + 2)).toEqual(["--resume", "sess-real"])
    expect(launch.args.at(-1)).toContain("Done on #97 only")
    expect(launch.args).not.toContain("--append-system-prompt-file")
  })

  test("won't launch in a folder Claude Code hasn't been allowed into, and says how to fix it", async () => {
    const s = setup(false)
    const { calls, runner } = fakeClaude()
    const r = await openTodoSession(items.get("T-1")!, { ...s, now: NOW, runner })
    expect(r).toMatchObject({ ok: false, reason: "not_trusted" })
    expect(r.ok ? "" : r.remedy).toContain(`claude\` in ${s.workspace}`)
    expect(calls.some((c) => c.args[0] === "--bg")).toBe(false)
  })

  test("reports a launch that didn't background", async () => {
    const s = setup()
    const r = await openTodoSession(items.get("T-1")!, { ...s, now: NOW, runner: fakeClaude({ launch: "Error: not logged in" }).runner })
    expect(r).toMatchObject({ ok: false, reason: "launch_failed" })
  })
})

describe("pickWorkdir and friends", () => {
  test("site plugin and nginx work runs in the linked local copy; everything else in Sentinel's folder", () => {
    const s = setup()
    expect(pickWorkdir(items.get("T-2")!, s.cfg)).toBe(s.local)
    expect(pickWorkdir(items.get("T-1")!, s.cfg)).toBe(s.workspace)
  })

  test("a trusted parent covers its children", () => {
    const s = setup()
    expect(isTrusted(join(s.workspace, "sites"), s.claudeJson)).toBe(true)
    expect(isTrusted("/somewhere/else", s.claudeJson)).toBe(false)
  })

  test("names and resume prompts", () => {
    expect(sessionName(items.get("T-2")!)).toBe("Samurai (T-2): Block a crawler")
    expect(resumePrompt(items.get("T-2")!, 1)).toBe("Picking T-2 back up. Where do things stand?")
  })
})

describe("reapTodoSessions", () => {
  const MIN = 60_000
  function world(opts: { status?: string; idleMin: number; closed?: boolean; dirty?: boolean; onMain?: boolean }) {
    const s = setup()
    writeFileSync(s.statePath, JSON.stringify({ "T-1": { todo: "T-1", sessionId: "sess-1", shortId: "abc123", name: "n", workdir: s.workspace, url: null, startedAt: "x", seenEvents: 1 } }))
    const evs = [ev({ id: "T-1", event: "created", kind: "monitoring", scope: "fleet", title: "t" })]
    if (opts.closed) evs.push(ev({ id: "T-1", event: "done", at: "2026-11-13T02:22:00Z", by: "claude@x" }))
    const ledger = fold(evs)
    const stops: string[] = []
    const gitCalls: string[][] = []
    let alive = true
    const runner: ClaudeRunner = {
      async run(args) {
        if (args[0] === "agents") return { code: 0, output: JSON.stringify([{ id: "abc123", sessionId: "sess-1", pid: alive ? 7 : undefined, status: opts.status ?? "idle" }]) }
        if (args[0] === "stop") {
          stops.push(args[1]!)
          alive = false
        }
        return { code: 0, output: "" }
      },
      sleep: async () => {},
    }
    const deps: Partial<ReapDeps> = {
      runner,
      lastActivity: () => NOW.getTime() - opts.idleMin * MIN,
      job: () => ({ worktreePath: "/wt", worktreeBranch: "worktree-x" }),
      exists: () => true,
      log: () => {},
      git: async (args) => {
        gitCalls.push(args)
        if (args[0] === "status") return { code: 0, output: opts.dirty ? " M SITE.md\n" : "" }
        if (args[0] === "rev-parse" && args.includes("origin/HEAD")) return { code: 0, output: "origin/main\n" }
        if (args[0] === "rev-parse") return { code: 0, output: "/repo/.git\n" }
        if (args[0] === "merge-base") return { code: 0, output: "base\n" }
        if (args[0] === "diff" && args[1] === "--name-only") return { code: 0, output: "sentinel/sites/a/SITE.md\n" }
        if (args[0] === "diff" && args[1] === "--quiet") return { code: opts.onMain === false ? 1 : 0, output: "" }
        return { code: 0, output: "" }
      },
    }
    return { s, ledger, deps, stops, gitCalls }
  }

  test("stops a closed to-do's session after 30 idle minutes and removes its spent worktree", async () => {
    const w = world({ closed: true, idleMin: 31 })
    const r = await reapTodoSessions(w.ledger, NOW, w.deps, w.s.statePath)
    expect(r).toEqual({ stopped: ["T-1"], worktrees: ["/wt"] })
    expect(w.stops).toEqual(["abc123"])
    expect(w.gitCalls.some((a) => a[0] === "worktree" && a.includes("/wt"))).toBe(true)
    expect(w.gitCalls.some((a) => a[0] === "branch" && a.includes("worktree-x"))).toBe(true)
  })

  test("leaves a closed to-do's session alone before 30 minutes, and an open one for a day", async () => {
    for (const o of [{ closed: true, idleMin: 20 }, { idleMin: 23 * 60 }]) {
      const w = world(o)
      expect((await reapTodoSessions(w.ledger, NOW, w.deps, w.s.statePath)).stopped).toEqual([])
    }
    const w = world({ idleMin: 25 * 60 })
    expect((await reapTodoSessions(w.ledger, NOW, w.deps, w.s.statePath)).stopped).toEqual(["T-1"])
  })

  test("never stops a session that's working", async () => {
    const w = world({ closed: true, idleMin: 120, status: "busy" })
    expect((await reapTodoSessions(w.ledger, NOW, w.deps, w.s.statePath)).stopped).toEqual([])
  })

  test("keeps a worktree with uncommitted changes, or with work that isn't on main", async () => {
    for (const o of [{ dirty: true }, { onMain: false }]) {
      const w = world({ closed: true, idleMin: 31, ...o })
      const r = await reapTodoSessions(w.ledger, NOW, w.deps, w.s.statePath)
      expect(r).toEqual({ stopped: ["T-1"], worktrees: [] })
      expect(w.gitCalls.some((a) => a[0] === "worktree")).toBe(false)
    }
  })

  test("an open to-do's worktree is never removed, even once its session is stopped", async () => {
    const w = world({ idleMin: 25 * 60 })
    expect(await reapTodoSessions(w.ledger, NOW, w.deps, w.s.statePath)).toEqual({ stopped: ["T-1"], worktrees: [] })
  })
})

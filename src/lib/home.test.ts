import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applySync, cloudSyncedBy, ensureHome, homeStatus, planSync, prepareWorkDir, readmeText, run } from "./home.ts"

// Isolated config and folder: nothing here touches the real ones.
const scratch = mkdtempSync(join(tmpdir(), "spinuptui-home-"))
process.env.XDG_CONFIG_HOME = join(scratch, "config")
process.env.SPINUPTUI_HOME = join(scratch, "SpinupTUI")
const home = process.env.SPINUPTUI_HOME
const bare = join(scratch, "remote.git")

beforeAll(async () => {
  await run(["git", "init", "--quiet", "--bare", "-b", "main", bare])
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test"
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.com"
})

describe("level 1: the README", () => {
  test("written once, on first use, never overwritten", () => {
    prepareWorkDir(join(home, "scheduler", "jobs"))
    expect(readFileSync(join(home, "README.md"), "utf8")).toBe(readmeText())
    writeFileSync(join(home, "README.md"), "mine")
    expect(ensureHome(home)).toBe(false)
    expect(readFileSync(join(home, "README.md"), "utf8")).toBe("mine")
  })

  test("a directory outside the folder gets no README", () => {
    const other = join(scratch, "elsewhere", "jobs")
    prepareWorkDir(other)
    expect(existsSync(join(scratch, "elsewhere", "README.md"))).toBe(false)
  })
})

describe("cloudSyncedBy", () => {
  test("recognises sync folders", () => {
    expect(cloudSyncedBy("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/SpinupTUI")).toBe("iCloud Drive")
    expect(cloudSyncedBy("/Users/x/Library/CloudStorage/Dropbox/SpinupTUI")).toBe("Dropbox")
    expect(cloudSyncedBy("/Users/x/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/S")).toBe("Google Drive")
    expect(cloudSyncedBy("/Users/x/Dropbox (Personal)/SpinupTUI")).toBe("Dropbox")
    expect(cloudSyncedBy("/Users/x/SpinupTUI")).toBe(null)
  })
})

describe("level 2: home sync", () => {
  test("asks where to keep it", async () => {
    const plan = await planSync({}, home)
    expect(plan.blockers.map((b) => b.reason)).toEqual(["need_remote"])
  })

  test("shares the folder to an empty remote, then has nothing to do", async () => {
    mkdirSync(join(home, "scheduler", "runs", "x"), { recursive: true })
    writeFileSync(join(home, "scheduler", "runs", "x", "state.json"), "{}\n")
    const plan = await planSync({ remote: bare }, home)
    expect(plan.blockers).toEqual([])
    expect(plan.mode).toBe("share")
    const r = await applySync(plan)
    expect(r.failed).toBeUndefined()
    const s = await homeStatus(home)
    expect(s.git).toBe(true)
    expect(s.remote).toBe(bare)
    expect(s.ahead).toBe(0)
    expect(readFileSync(join(home, ".gitignore"), "utf8")).toContain(".DS_Store")
    const files = (await run(["git", "-C", bare, "ls-tree", "-r", "--name-only", "main"])).out.split("\n")
    expect(files).toContain("scheduler/runs/x/state.json")
    expect((await planSync({}, home)).mode).toBe("nothing")
  })

  test("refuses a remote that already has commits", async () => {
    const other = join(scratch, "other")
    const plan = await planSync({ remote: bare }, other)
    expect(plan.blockers.map((b) => b.reason)).toContain("remote_not_empty")
  })

  test("a second machine clones it", async () => {
    const laptop = join(scratch, "laptop", "SpinupTUI")
    ensureHome(laptop) // the starter README a module already wrote there
    const plan = await planSync({ clone: bare }, laptop)
    expect(plan.blockers).toEqual([])
    expect((await applySync(plan)).ok).toBe(true)
    expect(existsSync(join(laptop, "scheduler", "runs", "x", "state.json"))).toBe(true)
    expect((await homeStatus(laptop)).remote).toBe(bare)
  })

  test("won't clone over work already there", async () => {
    const busy = join(scratch, "busy", "SpinupTUI")
    mkdirSync(join(busy, "scheduler", "jobs"), { recursive: true })
    writeFileSync(join(busy, "scheduler", "jobs", "a.md"), "x")
    const plan = await planSync({ clone: bare }, busy)
    expect(plan.blockers.map((b) => b.reason)).toEqual(["not_empty"])
  })

  test("won't nest inside another repository", async () => {
    const outer = join(scratch, "project")
    await run(["git", "init", "--quiet", outer])
    // Before the folder exists, too.
    expect((await planSync({ remote: bare }, join(outer, "SpinupTUI"))).blockers.map((b) => b.reason)).toContain("inside_repo")
    mkdirSync(join(outer, "SpinupTUI"), { recursive: true })
    expect((await planSync({ remote: bare }, join(outer, "SpinupTUI"))).blockers.map((b) => b.reason)).toContain("inside_repo")
  })
})

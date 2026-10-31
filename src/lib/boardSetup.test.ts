import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../config.ts"
import type { BasecampRun } from "./beaconBoard.ts"
import { checkLogin, listPeople, listProjects, makeBoard, overSsh, parseProjectId, postTest, saveBoard, setupBoardName } from "./boardSetup.ts"

const ok = (data: unknown) => ({ code: 0, out: JSON.stringify({ ok: true, data }) })
const answering = (routes: Record<string, { code: number; out: string }>): BasecampRun => async (args) => routes[args[0]!] ?? { code: 1, out: "" }
const noCli: BasecampRun = async () => {
  throw Object.assign(new Error("not found"), { code: "ENOENT" })
}

describe("checkLogin", () => {
  test("a yes is real", async () => {
    expect(await checkLogin(answering({ me: ok({ identity: { first_name: "Pat", last_name: "Doe" } }) }))).toEqual({ state: "confirmed", who: "Pat Doe" })
  })

  test("no CLI says how to install it", async () => {
    const r = await checkLogin(noCli)
    expect(r.state).toBe("missing")
    expect((r as { steps: string[] }).steps[0]).toContain("basecamp.com/install-cli")
  })

  test("a no is never stated as a fact", async () => {
    const r = await checkLogin(answering({}), false)
    expect(r.state).toBe("unconfirmed")
    expect((r as { steps: string[] }).steps[0]).toBe("Couldn't confirm the Basecamp login from this session.")
  })

  test("over SSH it names the reason and the headless login", async () => {
    const steps = ((await checkLogin(answering({}), true)) as { steps: string[] }).steps.join(" ")
    expect(steps).toContain("SSH session")
    expect(steps).toContain("basecamp auth login --remote")
  })

  test("overSsh", () => {
    expect(overSsh({ SSH_CONNECTION: "1 2 3 4" })).toBe(true)
    expect(overSsh({ SSH_TTY: "/dev/ttys1" })).toBe(true)
    expect(overSsh({})).toBe(false)
  })
})

describe("listing", () => {
  test("only projects with a message board, by name", async () => {
    const dock = [{ name: "message_board", enabled: true }]
    const run = answering({ projects: ok([{ id: 2, name: "Zed", dock }, { id: 1, name: "Alpha", dock }, { id: 3, name: "No board", dock: [{ name: "todoset" }] }, { id: 4, name: "Off", dock: [{ name: "message_board", enabled: false }] }]) })
    expect(await listProjects(run)).toEqual([{ id: "1", name: "Alpha" }, { id: "2", name: "Zed" }])
  })

  test("people once each, by name", async () => {
    expect(await listPeople(answering({ people: ok([{ name: "Zoe" }, { name: "Al" }, { name: "Zoe" }]) }))).toEqual(["Al", "Zoe"])
  })

  test("a failed listing is empty, not a crash", async () => {
    expect(await listProjects(answering({}))).toEqual([])
  })
})

test("parseProjectId takes an id or any project URL", () => {
  expect(parseProjectId(" 123 ")).toBe("123")
  expect(parseProjectId("https://3.basecamp.com/999/projects/123")).toBe("123")
  expect(parseProjectId("https://3.basecamp.com/999/buckets/123/messages/5")).toBe("123")
  expect(parseProjectId("nope")).toBeNull()
})

test("a test post mentions nobody", async () => {
  const calls: string[][] = []
  const run: BasecampRun = async (args) => {
    calls.push(args)
    if (args[0] === "api" && args[1] === "get") return ok({ dock: [{ id: 9, name: "message_board" }] })
    if (args[0] === "people") throw new Error("a test post shouldn't look anyone up")
    return ok({ id: 1, app_url: "u" })
  }
  expect(await postTest(makeBoard("5", "Pat Doe"), run)).toMatchObject({ ok: true })
  expect(calls.at(-1)![4]).not.toContain("bc-attachment")
})

describe("saving", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "boards-"))
  })

  test("keeps a board team-only, and re-setup finds the same name", async () => {
    expect(setupBoardName()).toBe("board")
    await saveBoard("team", makeBoard("5", null))
    expect(loadConfig().beacon?.boards?.team).toEqual({ type: "basecamp", projectId: "5", audience: "team" })
    expect(setupBoardName()).toBe("team")
  })
})

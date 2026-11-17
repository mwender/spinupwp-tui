import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { COMMANDS, EXPECT_TYPES, findCommand, nearCommands, renderCommandList, SCHEDULER_KINDS, TODO_KINDS, type Command, type Flag } from "./cliCommands.ts"
import { complete, formatCompletion, type Resolver } from "./cliComplete.ts"
import * as scheduler from "./cliScheduler.ts"
import * as beacon from "./cliBeacon.ts"
import * as home from "./cliHome.ts"
import * as todos from "./cliTodos.ts"
import * as sentinel from "./cliSentinel.ts"
import * as offline from "./cliOffline.ts"
import { KINDS } from "./schedulerJobs.ts"
import { TODO_KINDS as LEDGER_KINDS } from "./todos.ts"
import { EXPECT_TYPES as SENTINEL_EXPECT_TYPES } from "./sentinelExpect.ts"

function allFlags(cmd: Command): Flag[] {
  return [...(cmd.flags ?? []), ...(cmd.subs ?? []).flatMap(allFlags)]
}

// Each module's own usage text against the table, both ways for subcommands,
// and for flags: every flag the usage names is in the table, and every flag the
// module's parser reads a value for takes a value in the table (or completion
// would read that value as a subcommand).
const MODULES: { name: string; usage: string; valueFlags: Set<string> }[] = [
  { name: "scheduler", usage: scheduler.USAGE, valueFlags: scheduler.VALUE_FLAGS },
  { name: "beacon", usage: beacon.USAGE, valueFlags: beacon.VALUE_FLAGS },
  { name: "home", usage: home.USAGE, valueFlags: home.VALUE_FLAGS },
  { name: "todos", usage: todos.USAGE, valueFlags: todos.VALUE_FLAGS },
  { name: "sentinel", usage: sentinel.USAGE, valueFlags: sentinel.VALUE_FLAGS },
]

describe("the command table matches each module's usage", () => {
  for (const m of MODULES) {
    const cmd = findCommand([m.name])!
    test(`${m.name}: every subcommand in its usage is in the table`, () => {
      const named = [...m.usage.matchAll(new RegExp(`spinuptui ${m.name} ([a-z][a-z-]*)`, "g"))].map((x) => x[1]!)
      const subs = (cmd.subs ?? []).map((s) => s.name)
      for (const n of named) expect(subs).toContain(n)
    })
    test(`${m.name}: every subcommand in the table is in its usage`, () => {
      // Internal ones (run by the station itself) may stay out of it.
      for (const s of (cmd.subs ?? []).filter((s) => !s.internal)) expect(m.usage).toMatch(new RegExp(`\\b${s.name}\\b`))
    })
    test(`${m.name}: every flag in its usage is in the table`, () => {
      const names = new Set(allFlags(cmd).map((f) => f.name))
      for (const f of new Set([...m.usage.matchAll(/(--[a-z][a-z-]*)/g)].map((x) => x[1]!))) expect({ flag: f, known: names.has(f) }).toEqual({ flag: f, known: true })
    })
    test(`${m.name}: flags the parser reads a value for take one in the table`, () => {
      const flags = allFlags(cmd)
      for (const v of m.valueFlags) {
        const inTable = flags.filter((f) => f.name === v)
        if (!inTable.length) continue // parsed but not offered (e.g. a hidden flag)
        for (const f of inTable) expect({ flag: v, takesValue: !!f.value }).toEqual({ flag: v, takesValue: true })
      }
    })
  }

  test("offline: its value flags take values", () => {
    for (const name of ["offline", "online"]) {
      const flags = findCommand([name])!.flags!
      for (const v of offline.VALUE_FLAGS) expect(flags.find((f) => f.name === v)?.value).toBeTruthy()
    }
  })

  test("literal value lists match the modules that own them", () => {
    expect([...SCHEDULER_KINDS]).toEqual([...KINDS])
    expect([...TODO_KINDS]).toEqual([...LEDGER_KINDS])
    expect([...EXPECT_TYPES]).toEqual([...SENTINEL_EXPECT_TYPES])
  })

  test("every command index.tsx dispatches is in the table", () => {
    const src = readFileSync(join(import.meta.dir, "..", "index.tsx"), "utf8")
    const dispatched = [...src.matchAll(/command === "([a-z-]+)"/g)].map((x) => x[1]!)
    const names = COMMANDS.map((c) => c.name)
    for (const d of new Set(dispatched)) expect(names).toContain(d)
  })
})

describe("unknown commands", () => {
  test("suggest the near ones", () => {
    expect(nearCommands("shedule")).toEqual(["scheduler"])
    expect(nearCommands("completoin")).toEqual(["completion"])
    expect(nearCommands("sentinal")).toEqual(["sentinel"])
    expect(nearCommands("zzz")).toEqual([])
  })
})

describe("help", () => {
  const text = renderCommandList()
  test("lists every top-level command that isn't hidden", () => {
    for (const c of COMMANDS.filter((c) => !c.hidden)) expect(text).toContain(`spinuptui ${c.name}`)
  })
  test("names scheduler cancel", () => {
    expect(text).toMatch(/scheduler .*\bcancel\b/)
  })
  test("stays within 80 columns", () => {
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(80)
  })
})

describe("completion", () => {
  const resolve: Resolver = async (source) =>
    ({
      site: [{ value: "example.com", about: "web1" }],
      server: [{ value: "web1" }, { value: "web2" }],
      job: [{ value: "nightly-backup" }],
      channel: [{ value: "phone" }],
    })[source as string] ?? []
  const values = async (...words: string[]) => {
    const c = await complete(words, resolve)
    return c.kind === "values" ? c.items.map((i) => i.value) : c.kind
  }

  test("top-level commands", async () => {
    const v = await values("")
    expect(v).toContain("scheduler")
    expect(v).toContain("ssh-exec")
    expect(v).not.toContain("__complete")
  })
  test("subcommands", async () => {
    expect(await values("scheduler", "")).toEqual(expect.arrayContaining(["add", "cancel", "list", "show", "extend", "run"]))
  })
  test("job ids after scheduler cancel", async () => {
    expect(await values("scheduler", "cancel", "")).toEqual(["nightly-backup"])
  })
  test("flags once the arguments are filled", async () => {
    expect(await values("scheduler", "cancel", "nightly-backup", "")).toEqual(["--source", "--json"])
  })
  test("a flag's values, and a used flag isn't offered again", async () => {
    expect(await values("scheduler", "add", "x", "--kind", "")).toEqual([...SCHEDULER_KINDS])
    const after = await values("scheduler", "add", "x", "--kind", "script", "-")
    expect(after).not.toContain("--kind")
    expect(after).toContain("--every")
  })
  test("domains and servers", async () => {
    expect(await values("ssh", "")).toEqual(["example.com"])
    expect(await values("ssh", "example.com", "--server", "")).toEqual(["web1", "web2"])
    expect(await values("offline", "web1", "")).toEqual(["web1", "web2"])
  })
  test("nested subcommands", async () => {
    expect(await values("beacon", "listener", "")).toEqual(["install", "uninstall", "status", "check"])
    expect(await values("beacon", "remove", "")).toEqual(["phone"])
  })
  test("paths defer to the shell", async () => {
    expect(await values("pull", "files", "example.com", "")).toBe("dir")
    expect(formatCompletion({ kind: "dir" })).toBe(":dir\n")
  })
  test("nothing after --", async () => {
    expect(await values("ssh-exec", "example.com", "--", "")).toBe("none")
  })
  test("free text offers nothing", async () => {
    expect(await values("scheduler", "add", "")).toBe("none")
  })
  test("candidates print as value<TAB>description", () => {
    expect(formatCompletion({ kind: "values", items: [{ value: "a", about: "x\ty" }, { value: "b" }] })).toBe("a\tx y\nb\n")
  })
})

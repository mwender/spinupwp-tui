import { beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import {
  appendEvents,
  effectiveState,
  extractFollowups,
  fillPlaceholders,
  fold,
  ledgerPath,
  ledgerSection,
  planEntries,
  readLedger,
  relevantItems,
  validateFix,
  withLedger,
  type FollowupEvent,
} from "./followups.ts"
import { followupLines } from "./sentinelDigest.ts"

const now = new Date("2026-11-11T12:00:00Z")
const created = (id: string, at: string, over: Partial<FollowupEvent> = {}): FollowupEvent =>
  ({ v: 1, at, by: "sentinel", id, event: "created", kind: "monitoring", scope: "site:a.example.com", title: `item ${id}`, report: "sites/a.example.com/incidents/r.md", ...over }) as FollowupEvent

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "fu-cfg-"))
  process.env.SPINUPTUI_HOME = mkdtempSync(join(tmpdir(), "fu-home-"))
})

describe("fold", () => {
  test("state follows the events, in timestamp order, not line order", () => {
    const items = fold([
      { v: 1, at: "2026-11-10T10:00:00Z", by: "operator@mini", id: "F-1", event: "done", text: "fixed it" },
      created("F-1", "2026-11-09T10:00:00Z"),
      { v: 1, at: "2026-11-11T10:00:00Z", by: "sentinel", id: "F-1", event: "regressed", text: "back", report: "sites/a.example.com/incidents/s.md" },
    ])
    const f = items.get("F-1")!
    expect(f.state).toBe("open")
    expect(f.reports).toEqual(["sites/a.example.com/incidents/r.md", "sites/a.example.com/incidents/s.md"])
    expect(f.comments.map((c) => c.text)).toEqual(["fixed it", "back"])
  })

  test("notes are born done; snoozes run out", () => {
    const items = fold([
      created("F-1", "2026-11-09T10:00:00Z", { kind: "note" } as never),
      created("F-2", "2026-11-09T10:00:00Z"),
      { v: 1, at: "2026-11-09T11:00:00Z", by: "operator@mini", id: "F-2", event: "snoozed", until: "2026-11-10" },
    ])
    expect(items.get("F-1")!.state).toBe("done")
    expect(items.get("F-2")!.state).toBe("snoozed")
    expect(effectiveState(items.get("F-2")!, now)).toBe("open")
    expect(effectiveState(items.get("F-2")!, new Date("2026-11-10T12:00:00Z"))).toBe("snoozed")
  })

  test("a duplicate create keeps the first; an event for an unknown item is ignored", () => {
    const items = fold([created("F-1", "2026-11-09T10:00:00Z"), created("F-1", "2026-11-09T11:00:00Z", { title: "other" } as never), { v: 1, at: "2026-11-09T12:00:00Z", by: "x", id: "F-9", event: "done" }])
    expect(items.size).toBe(1)
    expect(items.get("F-1")!.title).toBe("item F-1")
  })
})

describe("the log on disk", () => {
  test("appends, skips a torn last line, and writes .gitattributes for the union merge", () => {
    appendEvents([created("F-1", "2026-11-09T10:00:00Z")])
    appendFileSync(ledgerPath(), '{"v":1,"at":"2026-11-09T1') // a crash mid-write
    expect(readLedger().skipped).toBe(1)
    appendEvents([created("F-2", "2026-11-09T11:00:00Z")])
    const l = readLedger()
    expect([...l.items.keys()]).toEqual(["F-1", "F-2"])
    expect(l.skipped).toBe(1)
    expect(readFileSync(join(ledgerPath(), "../.gitattributes"), "utf8")).toBe("followups.jsonl merge=union\n")
  })

  test("two clones that both append merge without a conflict and fold the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fu-git-"))
    const a = join(dir, "a")
    const b = join(dir, "b")
    await $`git init -q -b main ${a} && git -C ${a} config user.email t@t && git -C ${a} config user.name t`.quiet()
    const la = join(a, "sentinel/followups.jsonl")
    appendEvents([created("F-1", "2026-11-09T10:00:00Z")], la)
    await $`git -C ${a} add -A && git -C ${a} commit -qm one && git clone -q ${a} ${b} && git -C ${b} config user.email t@t && git -C ${b} config user.name t`.quiet()
    const lb = join(b, "sentinel/followups.jsonl")
    appendEvents([{ v: 1, at: "2026-11-10T10:00:00Z", by: "operator@a", id: "F-1", event: "comment", text: "from a" }], la)
    appendEvents([{ v: 1, at: "2026-11-10T11:00:00Z", by: "operator@b", id: "F-1", event: "done" }], lb)
    await $`git -C ${a} commit -qam a && git -C ${b} commit -qam b && git -C ${b} pull -q --no-rebase --no-edit ${a} main`.quiet()
    const merged = readLedger(lb)
    expect(merged.skipped).toBe(0)
    expect(merged.items.get("F-1")).toMatchObject({ state: "done", comments: [{ text: "from a" }] })
  })

  test("withLedger allocates under the lock", () => {
    const ids = [1, 2, 3].map(() =>
      withLedger((l) => {
        const id = `F-${l.items.size + 1}`
        return { events: [created(id, now.toISOString())], result: id }
      }),
    )
    expect(ids).toEqual(["F-1", "F-2", "F-3"])
  })
})

describe("the agent's block", () => {
  const answer = (block: string) => `# H\n\n## Follow-ups\n\n- [new-1] Add a monitor.\n- [F-3] Still the tolerance.\n\n\`\`\`followups\n${block}\n\`\`\`\n`

  test("extracts the last block and strips it from the report", () => {
    const ex = extractFollowups(answer('[{"ref":"new-1","kind":"monitoring","scope":"site:a.example.com","title":"Add a monitor"}]'))
    expect(ex.entries).toHaveLength(1)
    expect(ex.text).not.toContain("```")
    expect(ex.text).toEndWith("- [F-3] Still the tolerance.\n")
  })

  test("no block is fine; a bad one is an error and leaves the text alone", () => {
    expect(extractFollowups("# H\n")).toEqual({ text: "# H\n", entries: null })
    const bad = extractFollowups(answer("[{not json"))
    expect(bad.entries).toBeNull()
    expect(bad.error).toContain("isn't valid JSON")
    expect(bad.text).toContain("```followups")
  })

  test("plans creates, attaches and regressions, and refuses the rest", () => {
    const items = fold([
      created("F-3", "2026-11-01T00:00:00Z"),
      created("F-4", "2026-11-01T00:00:00Z"),
      { v: 1, at: "2026-11-02T00:00:00Z", by: "operator@mini", id: "F-4", event: "done" },
    ])
    const r = planEntries(
      [
        { ref: "new-1", kind: "monitoring", scope: "site:a.example.com", title: "Add a monitor", detail: "why" },
        { ref: "new-2", kind: "nginx", scope: "site:a.example.com", title: "Deny core files", fix: { template: "deny-paths", params: { paths: ["~ ^/wp-admin/includes/.*\\.php$"], status: 403 } } },
        { ref: "new-3", kind: "nginx", scope: "site:a.example.com", title: "Free-form", fix: { template: "anything", params: {} } },
        { ref: "F-3", event: "still-open", text: "again" },
        { ref: "F-4", event: "regressed", text: "it's back" },
        { ref: "F-99", event: "still-open" },
        { ref: "new-4", kind: "bogus", scope: "site:a.example.com", title: "x" },
        { ref: "new-5", kind: "watch", scope: "../../etc", title: "x" },
        { ref: "F-3", event: "done" }, // the agent can't close anything
      ],
      items,
      "sites/a.example.com/incidents/new.md",
      now.toISOString(),
    )
    expect(r.created).toEqual(["F-5", "F-6", "F-7"])
    expect(r.placeholders.get("new-1")).toBe("F-5")
    expect(r.events.find((e) => e.id === "F-6")).toMatchObject({ fix: { template: "deny-paths" } })
    expect(r.events.find((e) => e.id === "F-7")).not.toHaveProperty("fix")
    expect(r.stillOpen).toEqual(["F-3", "F-3"])
    expect(r.regressed.map((x) => x.id)).toEqual(["F-4"])
    expect(r.warnings).toHaveLength(4)
    const after = fold([...items.values()].flatMap((f) => f.history).concat(r.events))
    expect(after.get("F-3")!.state).toBe("open")
    expect(after.get("F-4")!.state).toBe("open")
  })

  test("fills placeholders, leaving unknown ones", () => {
    expect(fillPlaceholders("- [new-1] a\n- [NEW-2] b\n- [new-9] c", new Map([["new-1", "F-5"], ["new-2", "F-6"]]))).toBe("- [F-5] a\n- [F-6] b\n- [new-9] c")
  })

  test("validateFix rejects hostile parameters", () => {
    expect(validateFix({ template: "deny-paths", params: { paths: ["= /x; return 200"] } }).fix).toBeNull()
    expect(validateFix({ template: "deny-paths", params: { paths: ["/a\n}"] } }).fix).toBeNull()
    expect(validateFix({ template: "deny-paths", params: { paths: ["/a"], status: 200 } }).fix).toBeNull()
    expect(validateFix({ template: "deny-paths", params: { paths: [] } }).fix).toBeNull()
    expect(validateFix({ template: "block-user-agent", params: { pattern: "Go-http-client" } }).fix).not.toBeNull()
    expect(validateFix({ template: "cloudflare-real-ip" }).fix).toEqual({ template: "cloudflare-real-ip", params: {} })
  })
})

describe("what the agent sees", () => {
  test("site, server and fleet items, open or recently closed, with the operator's words", () => {
    const items = fold([
      created("F-1", "2026-11-01T00:00:00Z"),
      created("F-2", "2026-11-01T00:00:00Z", { scope: "server:web1.example.com" } as never),
      created("F-3", "2026-11-01T00:00:00Z", { scope: "fleet" } as never),
      created("F-4", "2026-11-01T00:00:00Z", { scope: "site:other.example.com" } as never),
      created("F-5", "2026-09-01T00:00:00Z"),
      { v: 1, at: "2026-09-02T00:00:00Z", by: "operator@mini", id: "F-5", event: "done" },
      created("F-6", "2026-11-01T00:00:00Z", { kind: "note" } as never),
      { v: 1, at: "2026-11-05T00:00:00Z", by: "operator@mini", id: "F-1", event: "wontfix", text: "Not worth a monitor." },
    ])
    const list = relevantItems(items, ["a.example.com"], "web1.example.com", now)
    expect(list.map((f) => f.id).sort()).toEqual(["F-1", "F-2", "F-3"])
    const text = ledgerSection(list, now)
    expect(text).toContain('F-1 [wontfix, monitoring, site:a.example.com] item F-1\n  The operator said (2026-11-05): "Not worth a monitor."')
    expect(ledgerSection([], now)).toContain("no follow-ups on record")
  })

  test("the digest line", () => {
    const items = fold([
      created("F-1", "2026-11-11T08:00:00Z"),
      created("F-2", "2026-11-01T00:00:00Z", { kind: "decision" } as never),
      created("F-3", "2026-11-01T00:00:00Z"),
      { v: 1, at: "2026-11-11T09:00:00Z", by: "operator@mini", id: "F-3", event: "done" },
      { v: 1, at: "2026-11-11T10:00:00Z", by: "sentinel", id: "F-3", event: "regressed", text: "back" },
    ])
    expect(followupLines([...items.values()], now)).toEqual(["To do: 3 open follow-ups (2 monitoring, 1 decision) · 1 new", "Back after a fix: F-3 item F-3"])
    expect(followupLines([], now)).toEqual([])
  })
})

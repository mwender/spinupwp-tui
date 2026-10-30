import { describe, expect, test } from "bun:test"
import type { BeaconBoard } from "../config.ts"
import { markdownToBasecampHtml, postToBoard, splitTitle, type BasecampRun } from "./beaconBoard.ts"

const board: BeaconBoard = { type: "basecamp", projectId: "123", mention: "Pat Doe", audience: "team" }

function fakeCli(post: { code: number; out: string }): { run: BasecampRun; calls: string[][] } {
  const calls: string[][] = []
  const run: BasecampRun = async (args) => {
    calls.push(args)
    if (args[0] === "api" && args[1] === "get") return { code: 0, out: JSON.stringify({ ok: true, data: { dock: [{ id: 9, name: "message_board" }] } }) }
    if (args[0] === "people") return { code: 0, out: JSON.stringify({ ok: true, data: [{ name: "Pat Doe", attachable_sgid: "sg" }] }) }
    return post
  }
  return { run, calls }
}

describe("markdownToBasecampHtml", () => {
  test("renders what a report uses", () => {
    const html = markdownToBasecampHtml("## Root cause\n\nThe **cron** ran `wp` twice.\n\n- [x] done\n- [ ] todo\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```\nx < y\n```\n")
    expect(html).toContain("<h2>Root cause</h2>")
    expect(html).toContain("<p>The <strong>cron</strong> ran <code>wp</code> twice.</p>")
    expect(html).toContain("<li>☑ done</li>")
    expect(html).toContain("<li>☐ todo</li>")
    expect(html).toContain("<th>A</th>")
    expect(html).toContain("<td>2</td>")
    expect(html).toContain("<pre><code>x &lt; y</code></pre>")
  })

  test("escapes anything a log line could carry, and joins soft-wrapped text", () => {
    expect(markdownToBasecampHtml("a <script>alert(1)</script>\nb")).toBe("<p>a &lt;script&gt;alert(1)&lt;/script&gt; b</p>")
    expect(markdownToBasecampHtml("<img src=x onerror=y>")).toBe("<p>&lt;img src=x onerror=y&gt;</p>")
  })

  test("keeps real links and flattens local ones", () => {
    expect(markdownToBasecampHtml("[a](https://example.com) [b](2026-10-30-x.md)")).toBe('<p><a href="https://example.com">a</a> b</p>')
  })
})

describe("postToBoard", () => {
  const report = "# 10/30/2026 (13:34) - example.com - health\n\n## Symptom\n\nDown."

  test("uses the H1 as the title and returns the message", async () => {
    const { run, calls } = fakeCli({ code: 0, out: JSON.stringify({ ok: true, data: { id: 42, app_url: "https://bc/42" } }) })
    expect(await postToBoard(board, report, run)).toEqual({ ok: true, id: "42", url: "https://bc/42" })
    const post = calls.find((c) => c[1] === "post")!
    expect(post[2]).toBe("buckets/123/message_boards/9/messages.json")
    const payload = JSON.parse(post[4]!) as { subject: string; content: string }
    expect(payload.subject).toBe("10/30/2026 (13:34) - example.com - health")
    expect(payload.content).toContain('sgid="sg"')
    expect(payload.content).not.toContain("<h1")
  })

  test("refuses a report with no title, and anything but a team board", async () => {
    const { run } = fakeCli({ code: 0, out: "{}" })
    expect(await postToBoard(board, "no heading", run)).toMatchObject({ ok: false, reason: "bad_report" })
    expect(await postToBoard({ ...board, audience: "client" as never }, report, run)).toMatchObject({ ok: false })
  })

  test("reports a refused post", async () => {
    const { run } = fakeCli({ code: 1, out: "nope" })
    expect(await postToBoard(board, report, run)).toMatchObject({ ok: false, reason: "api" })
  })

  test("splitTitle", () => {
    expect(splitTitle("# T\nbody")).toEqual({ title: "T", body: "body" })
    expect(splitTitle("body").title).toBe("")
  })
})

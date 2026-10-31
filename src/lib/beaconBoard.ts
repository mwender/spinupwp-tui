// Beacon's boards: a Basecamp project's message board, for the team's own record
// (docs/2026-10-30_sentinel-spec.md, "Basecamp"). A board isn't a pager channel.
// It carries reports for the team that owns the fleet, and nothing here can reach
// a client: `audience` only accepts "team" until that gate is built.
//
// The HTML is made here rather than by the CLI's converter, whose output depends
// on the installed version: one version posted a whole report as literal ## and
// **. The post goes through `basecamp api`, so its login stays the CLI's business.
// Basecamp has no idempotency key, so a caller must record a post before and
// after making it (see the worker) rather than retry blindly.

import type { BeaconBoard } from "../config.ts"
import { jobEnv } from "./schedulerRun.ts"
import { spawn } from "./spawn.ts"

// ---- Markdown → Basecamp HTML ------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;")

const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/
const TASK_MARK = /^\[([ xX])\]\s+/
const TABLE_SEP = /^\s*\|[\s:|-]+\|\s*$/

function inline(text: string): string {
  const spans: string[] = []
  let out = text.replace(/`([^`]+)`/g, (_, code: string) => {
    spans.push(`<code>${esc(code)}</code>`)
    return `\x00${spans.length - 1}\x00`
  })
  out = esc(out)
  // A relative link points at a local file that means nothing to a board reader.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, target: string) =>
    /^(https?:\/\/|mailto:)/.test(target) ? `<a href="${escAttr(target)}">${label}</a>` : label,
  )
  out = out.replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")
  out = out.replace(/(?<![\w*])\*(?!\s)([^*]+?)(?<!\s)\*(?![\w*])/g, "<em>$1</em>")
  // eslint-disable-next-line no-control-regex
  return out.replace(/\x00(\d+)\x00/g, (_, n: string) => spans[Number(n)]!)
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
}

// Headings, paragraphs, lists with task items, GFM tables, fenced code,
// blockquotes, rules, bold, italic, code and links: what a report uses.
export function markdownToBasecampHtml(md: string): string {
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    if (line.trimStart().startsWith("```")) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) code.push(lines[i++]!)
      i++
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`)
      continue
    }
    if (/^\s*-{3,}\s*$/.test(line)) {
      out.push("<hr>")
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = Math.min(Math.max(heading[1]!.length, 2), 4) // never an h1 in a post
      out.push(`<h${level}>${inline(heading[2]!.trim())}</h${level}>`)
      i++
      continue
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const rows = [splitRow(line)]
      i += 2
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!))
      const body = rows.map((cells, n) => `<tr>${cells.map((c) => `<${n ? "td" : "th"}>${inline(c)}</${n ? "td" : "th"}>`).join("")}</tr>`)
      out.push(`<table>\n${body.join("\n")}\n</table>`)
      continue
    }
    if (line.trimStart().startsWith("> ")) {
      const quote: string[] = []
      while (i < lines.length && lines[i]!.trimStart().startsWith(">")) quote.push(lines[i++]!.trimStart().slice(1).trim())
      out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`)
      continue
    }
    const first = LIST_ITEM.exec(line)
    if (first) {
      const ordered = first[2] !== undefined
      const items: string[] = []
      while (i < lines.length && lines[i]!.trim()) {
        const m = LIST_ITEM.exec(lines[i]!)
        if (m && (m[2] !== undefined) === ordered) {
          const text = m[3]!
          const task = TASK_MARK.exec(text)
          items.push(task ? `${task[1]!.toLowerCase() === "x" ? "☑" : "☐"} ${text.slice(task[0].length)}` : text)
        } else {
          items[items.length - 1] += ` ${lines[i]!.trim()}`
        }
        i++
      }
      const tag = ordered ? "ol" : "ul"
      out.push(`<${tag}>\n${items.map((t) => `<li>${inline(t)}</li>`).join("\n")}\n</${tag}>`)
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim()) {
      const next = lines[i]!
      if (para.length && (HEADING.test(next) || LIST_ITEM.test(next) || /^\s*(```|> |\|)/.test(next))) break
      para.push(next.trim())
      i++
    }
    out.push(`<p>${inline(para.join(" "))}</p>`)
  }
  return out.join("\n")
}

// A report's first line, its H1, is the post's title.
export function splitTitle(md: string): { title: string; body: string } {
  const m = /^\s*#\s+(.*?)\s*(\n|$)/.exec(md)
  return m ? { title: m[1]!, body: md.slice(m[0].length) } : { title: "", body: md }
}

// ---- the post ----------------------------------------------------------------------

export type BasecampRun = (args: string[]) => Promise<{ code: number; out: string }>

export const realRun: BasecampRun = async (args) => {
  const p = spawn(["basecamp", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: jobEnv() })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  return { code, out: code === 0 ? out : `${out}${err}`.trim() }
}

export type BoardPost = { ok: true; id: string; url: string } | { ok: false; reason: "cli_missing" | "auth" | "bad_report" | "api"; message: string }

interface CliEnvelope<T> {
  ok?: boolean
  data?: T
}

export async function cliJson<T>(run: BasecampRun, args: string[]): Promise<T | null> {
  const r = await run([...args, "--json"])
  if (r.code !== 0) return null
  try {
    const parsed = JSON.parse(r.out) as CliEnvelope<T>
    return parsed.ok === false ? null : (parsed.data ?? null)
  } catch {
    return null
  }
}

// Is the CLI logged in? A "yes" is real. A "no" is only meaningful from the login
// session (the dispatcher): a sandboxed shell, and maybe an SSH session, can't read
// the Keychain, so a "no" there proves nothing. See boardSetup.ts.
export async function boardLogin(run: BasecampRun = realRun): Promise<{ ok: boolean; state: "ok" | "no" | "missing"; detail: string }> {
  try {
    const me = await cliJson<{ identity?: { first_name?: string; last_name?: string } }>(run, ["me"])
    if (!me) return { ok: false, state: "no", detail: "not logged in: run `basecamp auth login` in a terminal on this machine" }
    return { ok: true, state: "ok", detail: [me.identity?.first_name, me.identity?.last_name].filter(Boolean).join(" ") || "logged in" }
  } catch {
    return { ok: false, state: "missing", detail: "the basecamp CLI isn't on the PATH" }
  }
}

export async function postToBoard(board: BeaconBoard, report: string, run: BasecampRun = realRun): Promise<BoardPost> {
  if (board.audience !== "team") return { ok: false, reason: "api", message: "Only team boards are supported." }
  const { title, body } = splitTitle(report)
  if (!title) return { ok: false, reason: "bad_report", message: "The report has no H1 to use as the post's title." }
  try {
    const project = await cliJson<{ dock?: { id: number; name: string }[] }>(run, ["api", "get", `buckets/${board.projectId}.json`])
    const boardId = project?.dock?.find((d) => d.name === "message_board")?.id
    if (!boardId) return { ok: false, reason: "auth", message: `Couldn't read project ${board.projectId}'s message board. Is \`basecamp\` logged in?` }
    let content = markdownToBasecampHtml(body)
    if (board.mention) {
      // A mention's sgid is signed and expires, so it's resolved every time.
      const people = await cliJson<{ name: string; attachable_sgid: string }[]>(run, ["people", "pingable"])
      const sgid = people?.find((p) => p.name === board.mention)?.attachable_sgid
      if (sgid) content = `<p><bc-attachment sgid="${escAttr(sgid)}" content-type="application/vnd.basecamp.mention"></bc-attachment> — new incident diagnosed and documented.</p>\n${content}`
    }
    const r = await run(["api", "post", `buckets/${board.projectId}/message_boards/${boardId}/messages.json`, "-d", JSON.stringify({ subject: title, status: "active", content }), "--json"])
    if (r.code === 0) {
      const d = (JSON.parse(r.out) as CliEnvelope<{ id: number; app_url: string }>).data
      if (d?.id) return { ok: true, id: String(d.id), url: d.app_url }
    }
    return { ok: false, reason: "api", message: `Basecamp refused the post: ${r.out.slice(0, 300)}` }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return e.code === "ENOENT" ? { ok: false, reason: "cli_missing", message: "The basecamp CLI isn't on the PATH." } : { ok: false, reason: "api", message: e.message }
  }
}

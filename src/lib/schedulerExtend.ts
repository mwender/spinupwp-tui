// Moving a job's `expires:` later — `spinuptui scheduler extend`, and the
// "Extend 1 year" button on Beacon's /jobs reply. Both go through extendJob(),
// so a tap and a command commit the same change the same way.
//
// The job file is edited in place: only the `expires:` line changes, keeping the
// header's order and any trailing " # comment", so the commit is a one-line diff.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fmtDate, parseDate } from "./schedule.ts"
import { jobsDir, parseJobText, validateJob, type Source } from "./schedulerJobs.ts"
import { git, gitPull } from "./schedulerGit.ts"

export const PERIOD_RE = /^([1-9]\d{0,2})([dwmy])$/

// `date` moved forward by a period like 30d, 2w, 6m or 1y. Months and years
// clamp to the month's last day, so 2028-02-29 + 1y is 2029-02-28.
export function addPeriod(date: Date, period: string): Date {
  const m = period.trim().toLowerCase().match(PERIOD_RE)
  if (!m || +m[1]! === 0) throw new Error(`--by takes a period like 30d, 2w, 6m or 1y, got "${period}"`)
  const n = +m[1]!
  const unit = m[2]!
  if (unit === "d" || unit === "w") return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n * (unit === "w" ? 7 : 1))
  const months = unit === "y" ? n * 12 : n
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last))
}

// The new expiry: an explicit date, or a period added to the current expiry —
// or to today, when the job has already expired, so "1y" always means a year
// of runs from now on.
export function newExpiry(current: string, to: { date?: string; by?: string }, today: Date): string {
  if (to.date) return fmtDate(parseDate(to.date))
  const cur = parseDate(current)
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return fmtDate(addPeriod(cur < day ? day : cur, to.by!))
}

// The job file's text with one header value replaced, everything else as written.
export function setHeaderValue(text: string, key: string, value: string): string {
  const lines = text.split("\n")
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === "---") break
    const colon = line.indexOf(":")
    if (colon === -1 || line.slice(0, colon).trim().toLowerCase() !== key) continue
    const hash = line.indexOf(" #", colon)
    const comment = hash === -1 ? "" : line.slice(hash).replace(/^\s*/, "   ")
    lines[i] = `${line.slice(0, colon + 1)} ${value}${comment}`
    return lines.join("\n")
  }
  throw new Error(`the header has no ${key}: line`)
}

export type ExtendResult =
  | { ok: true; source: string; id: string; from: string; to: string; path: string; pushed: boolean | null }
  | { ok: false; reason: string; message: string; remedy?: string }

export async function extendJob(s: Source, id: string, to: { date?: string; by?: string }, opts: { now?: Date; push?: boolean } = {}): Promise<ExtendResult> {
  const push = opts.push ?? true
  if (s.git && push) {
    const e = await gitPull(s.path)
    if (e) return { ok: false, reason: "git_failed", message: `${s.name}: ${e}` }
  }
  const path = join(jobsDir(s), `${id}.md`)
  if (!existsSync(path)) return { ok: false, reason: "unknown_job", message: `No ${s.name}/jobs/${id}.md.` }
  const text = readFileSync(path, "utf8")
  let from: string
  let next: string
  let updated: string
  try {
    from = parseJobText(text).header.expires ?? ""
    if (!from) throw new Error("the header has no expires: line")
    next = newExpiry(from, to, opts.now ?? new Date())
    updated = setHeaderValue(text, "expires", next)
  } catch (err) {
    return { ok: false, reason: "invalid_job", message: `${s.name}/jobs/${id}.md: ${(err as Error).message}` }
  }
  if (parseDate(next) <= parseDate(from)) {
    return {
      ok: false,
      reason: "not_later",
      message: `${id} already expires ${from}; ${next} isn't later.`,
      remedy: "Give a later date. To stop a job sooner, cancel it.",
    }
  }
  const parsed = parseJobText(updated)
  const problems = validateJob(parsed.header, parsed.body, `${id}.md`)
  if (problems.length) return { ok: false, reason: "invalid_job", message: `Not extended: ${problems.join("; ")}` }

  writeFileSync(`${path}.tmp`, updated)
  renameSync(`${path}.tmp`, path)
  let pushed: boolean | null = null
  if (s.git && push) {
    await git(s.path, "add", "--", path)
    await git(s.path, "commit", "--quiet", "-m", `job: extend ${id} to ${next}`, "--", path)
    const r = await git(s.path, "push", "--quiet")
    if (r.code !== 0) {
      return { ok: false, reason: "push_failed", message: `Extended ${s.name}/jobs/${id}.md to ${next} and committed it, but the push failed, so other machines won't see it until it's pushed:\n${r.out}` }
    }
    pushed = true
  }
  return { ok: true, source: s.name, id, from, to: next, path, pushed }
}

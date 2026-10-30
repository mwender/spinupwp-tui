// The diagnosis worker: everything slow, outside the tick. A tick starts it when
// work is queued, and it takes the oldest incident at a time until none are left,
// then exits. It isn't a scheduled unit, and only one runs at a time.
//
// The worker, not the agent, saves the report and posts it. So a missing write
// permission can't lose a report, and nothing the agent read can make it publish
// (docs/2026-10-30_sentinel-spec.md, "Diagnosis").

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import type { AppConfig } from "../config.ts"
import { SpinupWPClient, type SpinupWPClientLike } from "../api/client.ts"
import { moduleWorkDir } from "../modules/contract.ts"
import { postToBoard } from "./beaconBoard.ts"
import { resolveSiblings } from "./cliSiblings.ts"
import { tryLock } from "./flock.ts"
import { prepareWorkDir } from "./home.ts"
import { commitAndPush } from "./schedulerGit.ts"
import { gitRootOf } from "./schedulerJobs.ts"
import { agentCommand, jobEnv, outcomeOf, runProcess, type ProcResult } from "./schedulerRun.ts"
import { diagnoseButton, startedToday, type Page } from "./sentinelIncidents.ts"
import { diagnosisPrompt, parseAgentReport } from "./sentinelPrompt.ts"
import { loadIncident, loadIncidents, loadTickState, saveIncident, saveTickState, transcriptsDir, workerLockPath, type Incident, type SentinelSettings } from "./sentinelState.ts"
import { MAX_ATTEMPTS, nextRetryAt, sendPage } from "./sentinelTick.ts"
import { runSiteDoctor } from "./siteDoctor.ts"
import { execSshCommand } from "./sshExec.ts"

const SNAPSHOT = "uptime; free -m | head -3; df -h / | tail -1"

export interface WorkerDeps {
  triage(i: Incident): Promise<string>
  agent(prompt: string, s: SentinelSettings): Promise<ProcResult | string>
  page(p: Page): Promise<string>
  post(report: string, s: SentinelSettings): Promise<{ ok: true; id: string; url: string } | { ok: false; message: string }>
  commit(s: SentinelSettings, message: string): Promise<void>
  now(): Date
}

// ---- triage ---------------------------------------------------------------------------

// What a person would look at first. Deterministic and needing no agent, so an
// install without one still gets a useful write-up. Each step can fail on its own.
//
// It never uses `siblings --probe`: one SSH attempt per co-tenant, on every
// incident, is how a station gets itself banned by fail2ban.
export async function triage(i: Incident, cfg: AppConfig, client: SpinupWPClientLike): Promise<string> {
  const domains = [...new Set(i.events.map((e) => e.domain))]
  const out: string[] = []
  const events = i.events.map((e) => `- ${e.time} UTC: ${e.domain} ${e.kind}${e.message ? `: ${e.message}` : ""}`)
  out.push(`### Events\n\n${events.join("\n")}`)

  const first = domains[0]!
  try {
    const sib = await resolveSiblings(first, client, cfg, {})
    if (sib.ok) {
      const sites = sib.sites.map((s) => `- ${s.domain}${s.isVanity ? " (vanity host)" : ""}${s.monitored ? "" : " (not monitored)"}`)
      out.push(`### Server\n\n${sib.server.name}: ${sib.server.size ?? "unknown size"}, Ubuntu ${sib.server.ubuntuVersion ?? "?"}\n\n${sites.join("\n")}`)
    } else out.push(`### Server\n\nCouldn't look it up: ${sib.message}`)
  } catch (err) {
    out.push(`### Server\n\nCouldn't look it up: ${(err as Error).message}`)
  }

  const doctor: string[] = []
  for (const d of domains.slice(0, 5)) {
    try {
      const r = await runSiteDoctor({ url: `https://${d}/` })
      doctor.push(`- ${d}: ${r.verdict}. ${r.summary}`)
    } catch (err) {
      doctor.push(`- ${d}: the check failed: ${(err as Error).message}`)
    }
  }
  out.push(`### HTTP\n\n${doctor.join("\n")}`)

  try {
    const r = await execSshCommand(first, SNAPSHOT, client, cfg)
    if (r.ok) out.push(`### Load on the box\n\n\`\`\`\n${r.stdout.trim()}\n\`\`\``)
  } catch {
    // SSH isn't reachable: the rest stands without it.
  }
  return out.join("\n\n")
}

// ---- saving and posting -----------------------------------------------------------------

const SAFE_SITE = /^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]+$/i
const safeSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)

// Files the report under `site` and returns its path relative to the workspace.
// `site` and `slug` came from the agent, so neither gets near a path unchecked.
export function saveReport(workspace: string, site: string, slug: string, body: string, now: Date): string {
  const day = now.toISOString().slice(0, 10)
  const dir = join("sites", site, "incidents")
  mkdirSync(join(workspace, dir), { recursive: true })
  let name = `${day}-${slug}.md`
  for (let n = 2; existsSync(join(workspace, dir, name)); n++) name = `${day}-${slug}-${n}.md`
  writeFileSync(join(workspace, dir, name), body)
  return join(dir, name)
}

function pointTo(workspace: string, paged: string, report: string, now: Date): void {
  const dir = join("sites", paged, "incidents")
  mkdirSync(join(workspace, dir), { recursive: true })
  const rel = relative(dir, report)
  writeFileSync(join(workspace, dir, `${now.toISOString().slice(0, 10)}-see-${report.split("/")[1]}.md`), `See [the report under ${report.split("/")[1]}](${rel}).\n`)
}

function templateReport(i: Incident, evidence: string): string {
  const e = i.events[0]!
  const t = new Date(`${e.time.replace(" ", "T").slice(0, 19)}Z`)
  const p = (n: number) => String(n).padStart(2, "0")
  const when = `${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())}/${t.getUTCFullYear()} (${p(t.getUTCHours())}:${p(t.getUTCMinutes())})`
  return `# ${when} - ${e.domain} - ${e.kind}\n\n## Evidence\n\n${evidence}\n`
}

function finish(i: Incident, s: SentinelSettings, deps: WorkerDeps, report: string, site: string, slug: string, summary: string): Page {
  const now = deps.now()
  const path = saveReport(s.workspace, site, slug, report, now)
  const paged = i.events[0]!.domain
  if (site !== paged) pointTo(s.workspace, paged, path, now)
  i.state = "reported"
  i.site = site
  i.reportPath = path
  i.reportedAt = now.toISOString()
  i.summary = summary
  saveIncident(i)
  return { text: `🧾 ${paged}: ${summary}\n\nReport: ${path}`, silent: false }
}

export async function postReport(i: Incident, report: string, s: SentinelSettings, deps: WorkerDeps): Promise<string | null> {
  if (!s.reportTo) return null
  i.post = "posting"
  saveIncident(i)
  const r = await deps.post(report, s)
  if (r.ok) {
    i.post = "posted"
    i.postId = r.id
    i.postUrl = r.url
    delete i.postError
    saveIncident(i)
    return null
  }
  i.post = "failed"
  i.postError = r.message
  saveIncident(i)
  return r.message
}

// ---- one incident ---------------------------------------------------------------------------

type Step = "next" | "stop"

async function diagnose(i: Incident, s: SentinelSettings, deps: WorkerDeps): Promise<Step> {
  i.state = "diagnosing"
  i.attempts++
  i.startedAt = deps.now().toISOString()
  saveIncident(i)
  i.evidence ??= await deps.triage(i).catch((err: Error) => `Triage failed: ${err.message}`)
  saveIncident(i)

  const paged = i.events[0]!.domain
  const deliver = async (page: Page, report: string) => {
    const failed = await postReport(i, report, s, deps)
    await deps.commit(s, `sentinel: ${i.id}`)
    await deps.page(failed ? { ...page, text: `${page.text}\n\n⚠️ Couldn't post it to the board: ${failed}\nRetry with: spinuptui sentinel post ${i.id}` } : page)
  }

  if (!s.agent) {
    const report = templateReport(i, i.evidence)
    await deliver(finish(i, s, deps, report, paged, `${i.events[0]!.kind}-${i.id.slice(9, 13)}`, `${i.events[0]!.kind} is down; the evidence is saved.`), report)
    return "next"
  }

  const r = await deps.agent(diagnosisPrompt(i, s.workspace, deps.now()), s)
  if (typeof r === "string") {
    i.state = "blocked"
    i.why = r
    saveIncident(i)
    await deps.page({ text: `🚧 ${paged} wasn't diagnosed: ${r}.`, silent: false, buttons: [[diagnoseButton(i.id, "Run again")]] })
    return "stop"
  }

  const transcript = () => {
    mkdirSync(transcriptsDir(), { recursive: true })
    writeFileSync(join(transcriptsDir(), `${i.id}-${i.attempts}.log`), r.output, { mode: 0o600 })
  }
  const status = outcomeOf(true, r.code, r.timedOut, r.output)

  if (status === "auth") {
    i.state = "waiting_agent"
    i.attempts--
    i.retryAfter = nextRetryAt(deps.now())
    saveIncident(i)
    // Once per lapse, however many incidents queue behind it.
    const ts = loadTickState()
    if (!ts.authPagedAt) {
      saveTickState({ ...ts, authPagedAt: deps.now().toISOString() })
      const waiting = loadIncidents().filter((x) => x.state === "waiting_agent" || x.state === "queued").length
      const how = s.agent === "claude" ? "run `claude` there, then /login" : "run `codex login` there"
      await deps.page({ text: `🚨 The ${s.agent} login on this station has lapsed, so ${waiting} incident(s) are waiting. Fix: ${how}. They'll start on their own once it's back.`, silent: false })
    }
    return "stop"
  }
  const ts = loadTickState()
  if (ts.authPagedAt) saveTickState({ ...ts, authPagedAt: undefined })

  const parsed = status === "ok" || status === "blocked" ? parseAgentReport(r.output) : null
  if (!parsed) {
    transcript()
    const why = status === "timeout" ? `timed out after ${s.timeoutMin} minutes` : status === "failed" ? `the agent exited ${r.code}` : "its answer wasn't in the report format"
    if (i.attempts < MAX_ATTEMPTS) i.state = "queued"
    else i.state = "failed"
    i.why = why
    saveIncident(i)
    if (i.state === "failed") await deps.page({ text: `❌ ${paged} wasn't diagnosed: ${why}. The transcript is in Sentinel's state folder.`, silent: false, buttons: [[diagnoseButton(i.id, "Run again")]] })
    return "next"
  }

  if (parsed.status === "blocked") {
    i.state = "blocked"
    i.why = parsed.why
    i.summary = parsed.summary
    saveIncident(i)
    await deps.page({ text: `🚧 ${paged} couldn't be diagnosed: ${parsed.why}`, silent: false, buttons: [[diagnoseButton(i.id, "Run again")]] })
    return "next"
  }
  if (parsed.status === "duplicate") {
    i.state = "reported"
    i.reportPath = parsed.path
    i.reportedAt = deps.now().toISOString()
    i.summary = parsed.summary
    saveIncident(i)
    await deps.page({ text: `🧾 ${paged} is already documented: ${parsed.path}`, silent: true })
    return "next"
  }
  const site = parsed.site && SAFE_SITE.test(parsed.site) ? parsed.site : paged
  const slug = safeSlug(parsed.slug ?? "") || `${i.events[0]!.kind}-${i.id.slice(9, 13)}`
  await deliver(finish(i, s, deps, parsed.body, site, slug, parsed.summary), parsed.body)
  return "next"
}

// ---- the loop ---------------------------------------------------------------------------------

export function realWorkerDeps(cfg: AppConfig, s: SentinelSettings): WorkerDeps {
  const client = new SpinupWPClient(cfg)
  return {
    triage: (i) => triage(i, cfg, client),
    agent: async (prompt, set) => {
      const env = jobEnv()
      const cmd = agentCommand({ agent: set.agent!, prompt, workdir: set.workspace, allow: set.allow, model: set.model ?? undefined }, env)
      if (typeof cmd === "string") return cmd
      return runProcess(cmd, { cwd: set.workspace, env, timeoutMs: set.timeoutMin * 60_000 })
    },
    page: (p) => sendPage(cfg, p, s.channel),
    post: async (report) => {
      const board = cfg.beacon?.boards?.[s.reportTo!]
      if (!board) return { ok: false, message: `there's no Beacon board named "${s.reportTo}"` }
      return postToBoard(board, report)
    },
    commit: async (set, message) => {
      // Only Sentinel's own folder. A workspace elsewhere belongs to its owner.
      const work = moduleWorkDir("sentinel")
      const root = gitRootOf(work)
      if (set.workspace === work && root) await commitAndPush(root, [relative(root, work)], message)
    },
    now: () => new Date(),
  }
}

export async function runWorker(s: SentinelSettings, deps: WorkerDeps): Promise<{ ran: number; locked?: boolean }> {
  const lock = tryLock(workerLockPath())
  if (!lock) return { ran: 0, locked: true }
  prepareWorkDir(s.workspace)
  mkdirSync(dirname(transcriptsDir()), { recursive: true })
  let ran = 0
  try {
    for (;;) {
      const all = loadIncidents()
      if (startedToday(all, deps.now()) >= s.maxDiagnosesPerDay) break
      const next = all.find((i) => i.state === "queued")
      if (!next) break
      // The file, not this list: a tap may have changed it since.
      const i = loadIncident(next.id)
      if (!i || i.state !== "queued") continue
      ran++
      if ((await diagnose(i, s, deps)) === "stop") break
    }
  } finally {
    lock.release()
  }
  return { ran }
}

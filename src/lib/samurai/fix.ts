// Propose, apply and roll back a Samurai fix. Spec: "The flow".
//
// A proposal is everything apply will do, written down before it does it: the
// to-do and its fix, the rendered rule, the whole new samurai.conf, the diff,
// the checks, and a hash over all of that. Apply takes the proposal's id and
// hash, so what runs is exactly what was shown; it refuses if the server's
// samurai.conf changed since the proposal was made.
//
// samurai.conf is never edited in place: it's rendered from the applied
// proposals for the site, in the order they were applied. A rolled-back
// proposal simply isn't rendered next time.
//
// Proposals live in ~/SpinupTUI/samurai/proposals/<id>.json (the SpinupTUI
// folder, so they're shared and backed up with it), and every outcome is an
// event on the to-do.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { moduleWorkDir } from "../../modules/contract.ts"
import { commitAndPush } from "../schedulerGit.ts"
import { gitRootOf } from "../schedulerJobs.ts"
import { commitLedger, signedBy } from "../todoActions.ts"
import { effectiveState, withLedger, type Todo, type TodoEvent } from "../todos.ts"
import { checkGate } from "./gate.ts"
import { gateCall, gateError, text, type GateTarget } from "./remote.ts"
import { deployCommitted, mirrorDir, SAMURAI_FILE, SAMURAI_HEADER, setUpHere, syncMirror } from "./setup.ts"
import { BROWSER_UA, fetchCloudflareRanges, render, type Check, type Rendered } from "./templates.ts"
import { spawn } from "../spawn.ts"

export type ProposalStatus = "proposed" | "applied" | "failed" | "rolled-back"

export interface CheckResult {
  label: string
  path: string
  userAgent?: string
  expected: string
  got: string
  ok: boolean
}

export interface Proposal {
  id: string
  hash: string
  todoId: string
  title: string
  domain: string
  template: string
  params: Record<string, unknown>
  rendered: Rendered
  block: string // this fix's lines in samurai.conf, with its tag line
  previous: string // samurai.conf when the proposal was made
  file: string // samurai.conf as apply will write it
  diff: string
  createdAt: string
  createdBy: string
  status: ProposalStatus
  appliedAt?: string
  commit?: string
  verification?: CheckResult[]
  error?: string
  rolledBackAt?: string
}

export const proposalsDir = () => join(moduleWorkDir("samurai"), "proposals")
const proposalPath = (id: string, dir = proposalsDir()) => join(dir, `${id}.json`)

export function loadProposal(id: string, dir = proposalsDir()): Proposal | null {
  try {
    return JSON.parse(readFileSync(proposalPath(id, dir), "utf8")) as Proposal
  } catch {
    return null
  }
}

export function listProposals(dir = proposalsDir()): Proposal[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadProposal(f.slice(0, -5), dir))
    .filter((p): p is Proposal => !!p)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function saveProposal(p: Proposal, dir = proposalsDir()): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(proposalPath(p.id, dir), JSON.stringify(p, null, 2) + "\n")
}

// Commits the proposals with the SpinupTUI folder, when that folder is in git.
async function commitProposals(message: string): Promise<string | null> {
  const dir = proposalsDir()
  const root = gitRootOf(dir)
  if (!root) return null
  return commitAndPush(root, [relative(root, dir)], message).catch((e: Error) => e.message)
}

// ---- rendering ----------------------------------------------------------------------

export function blockFor(p: Pick<Proposal, "todoId" | "id" | "template" | "title">, lines: string[]): string {
  return [`# ${p.todoId} ${p.template}: ${p.title.replace(/[\r\n]+/g, " ")} (proposal ${p.id})`, ...lines].join("\n")
}

export function renderFile(blocks: string[]): string {
  return SAMURAI_HEADER + blocks.map((b) => `\n${b}\n`).join("")
}

// The blocks of a site's applied proposals, in the order they were applied.
export function appliedBlocks(domain: string, all: Proposal[], except?: string): string[] {
  return all
    .filter((p) => p.domain === domain && p.status === "applied" && p.id !== except)
    .sort((a, b) => (a.appliedAt ?? "").localeCompare(b.appliedAt ?? ""))
    .map((p) => p.block)
}

// A small line diff: enough to show what a change adds and removes.
export function lineDiff(a: string, b: string): string {
  const x = a.split("\n")
  const y = b.split("\n")
  const n = x.length
  const m = y.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push(`  ${x[i]}`)
      i++
      j++
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+ ${y[j++]}`)
    else out.push(`- ${x[i++]}`)
  }
  return out.join("\n")
}

function hashOf(p: Omit<Proposal, "hash" | "status" | "createdAt" | "createdBy">): string {
  return createHash("sha256").update(JSON.stringify([p.id, p.todoId, p.domain, p.template, p.params, p.previous, p.file])).digest("hex").slice(0, 16)
}

// ---- checks from outside ------------------------------------------------------------

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

// A status, or "refused" when the connection was closed without an answer (an
// nginx 444) or Cloudflare reports the origin closed it.
export async function probe(domain: string, path: string, userAgent = "SpinupTUI-Samurai/1 (verify)", fetcher: Fetcher = fetch): Promise<number | "refused"> {
  try {
    const r = await fetcher(`https://${domain}${path}`, { redirect: "manual", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(20_000) })
    return [520, 521, 522, 525].includes(r.status) ? "refused" : r.status
  } catch {
    return "refused"
  }
}

export function judge(check: Check, got: number | "refused", before?: number | "refused"): CheckResult {
  const base = { label: check.label, path: check.path, ...(check.userAgent ? { userAgent: check.userAgent } : {}), got: String(got) }
  if (check.expect === "status") return { ...base, expected: String(check.status), ok: got === check.status }
  if (check.expect === "refused") return { ...base, expected: "refused", ok: got === "refused" }
  // The page answers as before: a working page still works, and a page that
  // was already failing fails the same way.
  const fine = (s: number | "refused" | undefined) => typeof s === "number" && s < 400
  const ok = fine(before) ? fine(got) : got === before
  return { ...base, expected: `as before (${before ?? "nothing"})`, ok }
}

// ---- propose ----------------------------------------------------------------------------

export type Failure = { ok: false; reason: string; message: string; remedy?: string }

export interface ProposeContext {
  todo: Todo
  target: GateTarget
  by: string
  now?: Date
  fetcher?: Fetcher
  dir?: string // proposals dir (tests)
}

export async function propose(ctx: ProposeContext, onStage: (line: string) => void = () => {}): Promise<{ ok: true; proposal: Proposal; alreadyInEffect: CheckResult[] } | Failure> {
  const f = ctx.todo
  const now = ctx.now ?? new Date()
  if (f.kind !== "nginx" || !f.fix) return { ok: false, reason: "no_fix", message: `${f.id} has no Samurai fix.` }
  if (effectiveState(f, now) !== "open") return { ok: false, reason: "not_open", message: `${f.id} isn't open.` }
  if (!f.scope.startsWith("site:")) return { ok: false, reason: "not_a_site", message: `${f.id} is about ${f.scope}, not one site; Samurai applies fixes to one site at a time.` }
  const domain = f.scope.slice(5)
  if (!setUpHere(domain)) return { ok: false, reason: "not_set_up", message: `${domain} isn't set up for Samurai on this machine.`, remedy: "Run Samurai's setup for it first (F on the site, or `spinuptui samurai setup`)." }

  const extra: { cloudflareRanges?: string[] } = {}
  if (f.fix.template === "cloudflare-real-ip") {
    onStage("Fetching Cloudflare's published IP ranges")
    extra.cloudflareRanges = (await fetchCloudflareRanges()) ?? undefined
  }
  const r = render(f.fix, { ...extra, today: now.toISOString().slice(0, 10) })
  if (!r.ok) return { ok: false, reason: "invalid_fix", message: `Samurai won't apply ${f.id}'s fix: ${r.message}` }

  onStage("Checking the gate")
  const gate = await checkRemoteGate(ctx.target)
  if (gate) return gate
  onStage("Refreshing the local copy of the config")
  const m = await syncMirror(domain, ctx.target)
  if (!m.ok) return { ok: false, reason: "mirror_failed", message: m.message }

  const all = listProposals(ctx.dir)
  const previous = readMirrorFile(domain)
  const expected = renderFile(appliedBlocks(domain, all))
  if (previous !== expected) {
    return {
      ok: false,
      reason: "drift",
      message: `${domain}'s ${SAMURAI_FILE} on the server isn't what Samurai's applied fixes add up to: it was changed some other way.`,
      remedy: `Compare it with the local copy in ${mirrorDir(domain)}, then put it back (or roll back the fix it disagrees with) before proposing more.`,
    }
  }

  onStage(`Checking ${domain} from outside, before`)
  const alreadyInEffect: CheckResult[] = []
  for (const c of r.rendered.checks.filter((c) => c.expect !== "same-as-before")) {
    const res = judge(c, await probe(domain, c.path, c.userAgent, ctx.fetcher))
    if (res.ok) alreadyInEffect.push(res)
  }
  const pathChecks = r.rendered.checks.filter((c) => c.expect !== "same-as-before").length
  if (pathChecks > 0 && alreadyInEffect.length === pathChecks) {
    return { ok: false, reason: "already_in_effect", message: `Every request the fix is meant to stop is already stopped (${alreadyInEffect.map((c) => `${c.path} → ${c.got}`).join(", ")}), so there's nothing for Samurai to add.`, remedy: `Mark ${f.id} done or won't fix instead.` }
  }

  const id = `${now.toISOString().slice(0, 10).replace(/-/g, "")}-${now.toISOString().slice(11, 19).replace(/:/g, "")}-${f.id}`
  const draft = { id, todoId: f.id, title: f.title, domain, template: f.fix.template, params: f.fix.params, rendered: r.rendered, block: "", previous, file: "", diff: "" }
  draft.block = blockFor(draft, r.rendered.lines)
  draft.file = renderFile([...appliedBlocks(domain, all), draft.block])
  draft.diff = lineDiff(previous, draft.file)
  const proposal: Proposal = { ...draft, hash: hashOf(draft), createdAt: now.toISOString(), createdBy: ctx.by, status: "proposed" }
  saveProposal(proposal, ctx.dir)
  await commitProposals(`samurai: propose ${f.id} (${proposal.id})`)
  return { ok: true, proposal, alreadyInEffect }
}

function readMirrorFile(domain: string): string {
  try {
    return readFileSync(join(mirrorDir(domain), SAMURAI_FILE), "utf8")
  } catch {
    return ""
  }
}

async function checkRemoteGate(target: GateTarget): Promise<Failure | null> {
  const v = await gateCall(target, "version")
  if (v.code !== 0) return { ok: false, reason: "gate_failed", message: `The gate didn't answer: ${gateError(v, `ssh exit ${v.code}`)}`, remedy: "Run Samurai's setup for the site again." }
  const h = await gateCall(target, "hash")
  const g = checkGate({ version: text(v.stdout), hash: text(h.stdout) }, target.gateSha256)
  return g.ok ? null : { ok: false, reason: "gate_failed", message: g.message }
}

// ---- apply and roll back ---------------------------------------------------------------

export interface ApplyContext {
  target: GateTarget
  by: string
  now?: () => Date
  fetcher?: Fetcher
  dir?: string
  ledgerPath?: string
  page?: (text: string) => Promise<void> // Beacon, when a fix had to be rolled back
}

async function git(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const named = await (async () => {
    const p = spawn(["git", "-C", dir, "config", "user.email"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    return (await p.exited) === 0
  })()
  const env = named ? undefined : { ...process.env, GIT_AUTHOR_NAME: "SpinupTUI", GIT_AUTHOR_EMAIL: "samurai@spinuptui.invalid", GIT_COMMITTER_NAME: "SpinupTUI", GIT_COMMITTER_EMAIL: "samurai@spinuptui.invalid" }
  const p = spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env })
  const [o, e] = await Promise.all([new Response(p.stdout as ReadableStream<Uint8Array>).text(), new Response(p.stderr as ReadableStream<Uint8Array>).text()])
  return { code: await p.exited, out: (o + e).trim() }
}

// Writes samurai.conf in the mirror, commits it and sends that commit through
// the gate. On a refused deploy the gate has already restored the server, so
// the mirror's commit is dropped too.
async function writeAndDeploy(domain: string, target: GateTarget, content: string, message: string): Promise<{ ok: true; commit: string; log: string } | { ok: false; message: string }> {
  const dir = mirrorDir(domain)
  writeFileSync(join(dir, SAMURAI_FILE), content)
  await git(dir, "add", SAMURAI_FILE)
  const c = await git(dir, "commit", "-q", "-m", message)
  if (c.code !== 0) return { ok: false, message: `git commit failed: ${c.out}` }
  const sha = (await git(dir, "rev-parse", "--short", "HEAD")).out
  const d = await deployCommitted(domain, target, [SAMURAI_FILE])
  if (!d.ok) {
    await git(dir, "reset", "-q", "--hard", "HEAD~1")
    return { ok: false, message: d.message }
  }
  return { ok: true, commit: sha, log: d.log }
}

function appendEvent(todoId: string, event: Omit<TodoEvent, "v" | "at" | "by" | "id">, by: string, at: Date, path?: string): void {
  withLedger(() => ({ events: [{ v: 1, at: at.toISOString(), by, id: todoId, ...event } as TodoEvent], result: null }), path)
}

async function runChecks(p: Proposal, before: Map<string, number | "refused">, fetcher?: Fetcher): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  for (const c of p.rendered.checks) {
    const ua = c.expect === "same-as-before" ? (c.userAgent ?? BROWSER_UA) : c.userAgent
    out.push(judge(c, await probe(p.domain, c.path, ua, fetcher), before.get(`${c.path}|${c.userAgent ?? ""}`)))
  }
  return out
}

export type ApplyOutcome =
  | { ok: true; proposal: Proposal; verification: CheckResult[] }
  | (Failure & { proposal?: Proposal; verification?: CheckResult[]; rolledBack?: boolean })

export async function applyProposal(id: string, hash: string, todo: Todo | undefined, ctx: ApplyContext, onStage: (line: string) => void = () => {}): Promise<ApplyOutcome> {
  const now = ctx.now ?? (() => new Date())
  const p = loadProposal(id, ctx.dir)
  if (!p) return { ok: false, reason: "unknown_proposal", message: `No proposal ${id}.` }
  if (p.hash !== hash) return { ok: false, reason: "hash_mismatch", message: `Proposal ${id} isn't the one you reviewed (its hash is ${p.hash}).` }
  if (p.status !== "proposed") return { ok: false, reason: "not_proposed", message: `Proposal ${id} is already ${p.status}.` }
  if (!todo || effectiveState(todo, now()) !== "open") return { ok: false, reason: "not_open", message: `${p.todoId} isn't open any more.` }

  onStage("Checking the gate")
  const gate = await checkRemoteGate(ctx.target)
  if (gate) return gate
  onStage("Refreshing the local copy of the config")
  const m = await syncMirror(p.domain, ctx.target)
  if (!m.ok) return { ok: false, reason: "mirror_failed", message: m.message }
  if (readMirrorFile(p.domain) !== p.previous) {
    return { ok: false, reason: "stale", message: `${SAMURAI_FILE} on ${p.domain} changed since this proposal was made.`, remedy: `Propose ${p.todoId} again.` }
  }

  onStage(`Checking ${p.domain} from outside, before`)
  const before = new Map<string, number | "refused">()
  for (const c of p.rendered.checks.filter((c) => c.expect === "same-as-before")) before.set(`${c.path}|${c.userAgent ?? ""}`, await probe(p.domain, c.path, c.userAgent ?? BROWSER_UA, ctx.fetcher))

  onStage(`Pushing ${SAMURAI_FILE} through the gate (nginx -t, then reload)`)
  const w = await writeAndDeploy(p.domain, ctx.target, p.file, `Samurai: ${p.todoId} ${p.template} (proposal ${p.id})`)
  if (!w.ok) {
    const failed: Proposal = { ...p, status: "failed", error: w.message }
    saveProposal(failed, ctx.dir)
    appendEvent(p.todoId, { event: "comment", text: `Samurai couldn't apply ${p.template} (proposal ${p.id}): ${w.message} The gate kept the previous config.` } as never, ctx.by, now(), ctx.ledgerPath)
    await Promise.all([commitProposals(`samurai: ${p.todoId} failed (${p.id})`), ctx.ledgerPath ? null : commitLedger(`todos: ${p.todoId} samurai failed`)])
    return { ok: false, reason: "deploy_failed", message: `nginx refused the change, so nothing changed on the server: ${w.message}`, proposal: failed }
  }

  onStage(`Checking ${p.domain} from outside, after`)
  const verification = await runChecks(p, before, ctx.fetcher)
  const bad = verification.filter((v) => !v.ok)
  if (bad.length) {
    onStage("A check failed: rolling back")
    const back = await writeAndDeploy(p.domain, ctx.target, p.previous, `Samurai: roll back ${p.todoId}, a check failed (proposal ${p.id})`)
    const why = bad.map((b) => `${b.label}: expected ${b.expected}, got ${b.got}`).join("; ")
    const failed: Proposal = { ...p, status: "failed", commit: w.commit, verification, error: `verification failed: ${why}${back.ok ? "" : `; the rollback failed too: ${back.message}`}` }
    saveProposal(failed, ctx.dir)
    appendEvent(p.todoId, { event: "comment", text: `Samurai applied ${p.template} (proposal ${p.id}), but a check from outside failed (${why}), so it rolled it back${back.ok ? "" : ` — and the rollback failed: ${back.message}`}.` } as never, ctx.by, now(), ctx.ledgerPath)
    await Promise.all([commitProposals(`samurai: ${p.todoId} rolled back (${p.id})`), ctx.ledgerPath ? null : commitLedger(`todos: ${p.todoId} samurai rolled back`)])
    await ctx.page?.(`Samurai rolled back ${p.todoId} on ${p.domain}: ${why}.${back.ok ? "" : ` The rollback failed: ${back.message}`}`).catch(() => {})
    return { ok: false, reason: back.ok ? "verify_failed" : "rollback_failed", message: back.ok ? `A check failed, so Samurai rolled the change back: ${why}.` : `A check failed and the rollback failed too: ${back.message}. Check ${p.domain} now.`, proposal: failed, verification, rolledBack: back.ok }
  }

  const applied: Proposal = { ...p, status: "applied", appliedAt: now().toISOString(), commit: w.commit, verification }
  saveProposal(applied, ctx.dir)
  appendEvent(p.todoId, { event: "fix-applied", proposal: p.id, text: `Samurai applied ${p.template}: ${verification.length} check${verification.length === 1 ? "" : "s"} from outside passed.` } as never, ctx.by, now(), ctx.ledgerPath)
  await Promise.all([commitProposals(`samurai: ${p.todoId} applied (${p.id})`), ctx.ledgerPath ? null : commitLedger(`todos: ${p.todoId} fixed by samurai`)])
  return { ok: true, proposal: applied, verification }
}

export async function rollbackProposal(id: string, ctx: ApplyContext, onStage: (line: string) => void = () => {}): Promise<ApplyOutcome> {
  const now = ctx.now ?? (() => new Date())
  const p = loadProposal(id, ctx.dir)
  if (!p) return { ok: false, reason: "unknown_proposal", message: `No proposal ${id}.` }
  if (p.status !== "applied") return { ok: false, reason: "not_applied", message: `Proposal ${id} is ${p.status}, so there's nothing to roll back.` }

  onStage("Checking the gate")
  const gate = await checkRemoteGate(ctx.target)
  if (gate) return gate
  onStage("Refreshing the local copy of the config")
  const m = await syncMirror(p.domain, ctx.target)
  if (!m.ok) return { ok: false, reason: "mirror_failed", message: m.message }
  const all = listProposals(ctx.dir)
  if (readMirrorFile(p.domain) !== renderFile(appliedBlocks(p.domain, all))) {
    return { ok: false, reason: "drift", message: `${p.domain}'s ${SAMURAI_FILE} on the server isn't what Samurai's applied fixes add up to, so Samurai won't rewrite it.`, remedy: `Compare it with the local copy in ${mirrorDir(p.domain)} first.` }
  }

  const home = { label: "the home page answers as before", path: "/", expect: "same-as-before" as const }
  const before = await probe(p.domain, "/", BROWSER_UA, ctx.fetcher)
  onStage(`Removing ${p.todoId}'s rule and pushing through the gate`)
  const w = await writeAndDeploy(p.domain, ctx.target, renderFile(appliedBlocks(p.domain, all, p.id)), `Samurai: roll back ${p.todoId} (proposal ${p.id})`)
  if (!w.ok) return { ok: false, reason: "deploy_failed", message: `nginx refused the change, so the rule is still in place: ${w.message}` }
  const verification = [judge(home, await probe(p.domain, "/", BROWSER_UA, ctx.fetcher), before)]
  const rolled: Proposal = { ...p, status: "rolled-back", rolledBackAt: now().toISOString() }
  saveProposal(rolled, ctx.dir)
  appendEvent(p.todoId, { event: "fix-rolled-back", proposal: p.id, text: `Rolled back Samurai's ${p.template} (proposal ${p.id}).` } as never, ctx.by, now(), ctx.ledgerPath)
  await Promise.all([commitProposals(`samurai: ${p.todoId} rolled back (${p.id})`), ctx.ledgerPath ? null : commitLedger(`todos: ${p.todoId} samurai fix rolled back`)])
  return { ok: true, proposal: rolled, verification }
}

export const latestProposalFor = (todoId: string, dir?: string): Proposal | null => listProposals(dir).filter((p) => p.todoId === todoId).at(-1) ?? null
export { signedBy }

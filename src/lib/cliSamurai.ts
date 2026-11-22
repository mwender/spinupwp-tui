// `spinuptui samurai …`: the CLI over Samurai. Headless like every module
// command: --json prints one result object on stdout, progress goes to
// stderr, failures use the { ok: false, reason, message, remedy? } shape and
// exit 1.

import { loadConfig } from "../config.ts"
import { SpinupWPClient } from "../api/client.ts"
import { resolveSiteByDomain } from "./cliSsh.ts"
import { getSudoPassword } from "./keychain.ts"
import { applySetup, keyPath, planSetup, type SetupContext, type SetupPlan } from "./samurai/setup.ts"
import { applyProposal, listProposals, loadProposal, propose, rollbackProposal, type ApplyOutcome, type Proposal } from "./samurai/fix.ts"
import type { GateTarget } from "./samurai/remote.ts"
import { readLedger } from "./todos.ts"
import { operator } from "./todoActions.ts"
import { beaconFromConfig, beaconSend } from "./beacon.ts"

export const USAGE = `Usage:
  spinuptui samurai setup <domain> [--server <name>] --plan | --apply [--json]
                           check the server, install the spinuptui-nginx gate,
                           register the site, copy its nginx config here and
                           prove the path end to end. --plan changes nothing.
  spinuptui samurai propose <todo-id> [--json]
                           show exactly what applying the to-do's fix would
                           change, and record it as a proposal. Changes nothing.
  spinuptui samurai apply <proposal> --hash <hash> [--json]
                           apply that proposal, exactly as shown, then check the
                           site from outside; a failed check rolls it back
  spinuptui samurai rollback <proposal> [--json]
                           take an applied fix's rule out again
  spinuptui samurai list [--json]
                           every proposal, applied or not

Setup's one root step uses the server's sudo user and the password SpinupTUI
saved in the Keychain: connect sudo with S on the server in the Servers tab and
tick "remember" first.`

export const VALUE_FLAGS = new Set(["--server", "--hash"])

interface Parsed {
  positionals: string[]
  flags: Map<string, string>
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (VALUE_FLAGS.has(a)) flags.set(a, argv[++i] ?? "")
    else if (a.startsWith("--")) flags.set(a, "")
    else positionals.push(a)
  }
  return { positionals, flags }
}

function fail(json: boolean, reason: string, message: string, remedy?: string): number {
  if (json) console.log(JSON.stringify({ ok: false, reason, message, ...(remedy ? { remedy } : {}) }))
  else console.error(remedy ? `${message}\n${remedy}` : message)
  return 1
}

export async function runSamurai(argv: string[]): Promise<number> {
  const p = parse(argv)
  const json = p.flags.has("--json")
  const [sub, domain] = p.positionals
  if (sub === "setup") return setup(domain, p, json)
  if (sub === "propose") return proposeCmd(domain, json)
  if (sub === "apply") return applyCmd(domain, p, json)
  if (sub === "rollback") return rollbackCmd(domain, json)
  if (sub === "list") return listCmd(json)
  return fail(json, "usage", USAGE)
}

async function context(domain: string, p: Parsed, json: boolean): Promise<SetupContext | number> {
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  const r = await resolveSiteByDomain(domain, client, cfg, { server: p.flags.get("--server") ?? null })
  if (!r.ok) {
    const lines = [r.result.message, ...(r.result.candidates ?? []).map((c) => `  · ${c.server} (site ${c.siteId})`)]
    return fail(json, r.result.reason, lines.join("\n"), r.result.reason === "multiple_matches" ? "Pick one with --server <name>." : r.result.remedy)
  }
  const stored = cfg.sudoUsers[String(r.server.id)]
  const password = stored?.keychain ? await getSudoPassword(r.server.id) : null
  return { domain: r.site.domain, site: r.site, server: r.server, sudo: stored ? { user: stored.user, password: password ?? "" } : null }
}

function printPlan(plan: Extract<SetupPlan, { ok: true }>): void {
  console.log(`Samurai setup for ${plan.domain} (through ${plan.sshTarget})\n`)
  plan.steps.forEach((s, i) => console.log(`${s.done ? "✓" : `${i + 1}.`} ${s.title}\n   ${s.detail}`))
  if (plan.writes.length) {
    console.log(`\nThe root step writes:`)
    for (const w of plan.writes) console.log(`  ${w}`)
  }
  for (const n of plan.notes) console.log(`\nNote: ${n}`)
}

async function setup(domain: string | undefined, p: Parsed, json: boolean): Promise<number> {
  if (!domain) return fail(json, "usage", USAGE)
  const apply = p.flags.has("--apply")
  if (apply === p.flags.has("--plan")) return fail(json, "usage", `Pass --plan to see what setup would do, or --apply to do it.\n\n${USAGE}`)
  const ctx = await context(domain, p, json)
  if (typeof ctx === "number") return ctx
  const plan = await planSetup(ctx)
  if (!plan.ok) return fail(json, plan.reason, plan.message, plan.remedy)
  if (!apply) {
    if (json) console.log(JSON.stringify({ ...plan, gateTarget: undefined }))
    else printPlan(plan)
    return 0
  }
  if (plan.needsSudo && !ctx.sudo?.password) {
    return fail(json, "no_sudo_password", `Setup needs ${ctx.sudo?.user ?? "the sudo user"}'s sudo password, and it isn't saved in the Keychain.`, "Press S on the server in the Servers tab, enter it and tick \"remember\", then run this again.")
  }
  const r = await applySetup(plan, ctx, (line) => process.stderr.write(`→ ${line}\n`))
  if (!r.ok) return fail(json, r.reason, r.message, r.remedy)
  if (json) console.log(JSON.stringify({ ...r, domain: plan.domain }))
  else {
    console.log(`Samurai is set up for ${plan.domain}.`)
    console.log(`  ${plan.domain} answered ${r.before ?? "nothing"} before the push and ${r.after} after.`)
    if (r.deployLog) console.log(r.deployLog.split("\n").map((l) => `  gate: ${l}`).join("\n"))
  }
  return 0
}

// ---- fixes ------------------------------------------------------------------------

const progress = (line: string) => process.stderr.write(`→ ${line}\n`)

async function targetFor(domain: string, json: boolean): Promise<GateTarget | number> {
  const cfg = loadConfig()
  const r = await resolveSiteByDomain(domain, new SpinupWPClient(cfg), cfg, { server: null })
  if (!r.ok) return fail(json, r.result.reason, r.result.message, r.result.remedy)
  if (!r.server.ip_address) return fail(json, "no_ip", `${r.server.name} has no IP address in SpinupWP.`)
  return { ip: r.server.ip_address, port: r.server.ssh_port ?? null, keyPath: keyPath(r.site.domain) }
}

const page = async (text: string) => {
  await beaconSend(beaconFromConfig(loadConfig()), text)
}

function printProposal(p: Proposal, already: { path: string; got: string }[] = []): void {
  console.log(`Proposal ${p.id} for ${p.todoId} on ${p.domain} (${p.template})\n`)
  console.log(`${p.domain}'s server/samurai.conf would change like this:\n`)
  console.log(p.diff.split("\n").filter((l) => !l.startsWith("  #")).map((l) => `  ${l}`).join("\n"))
  console.log(`\nChecked from outside afterwards:`)
  for (const c of p.rendered.checks) console.log(`  · ${c.label}`)
  for (const n of p.rendered.notes) console.log(`Note: ${n}`)
  for (const a of already) console.log(`Note: ${a.path} is already answered with ${a.got}; the rule stays in for it anyway.`)
  console.log(`\nIf a check fails, Samurai puts the previous file back. To roll it back later: spinuptui samurai rollback ${p.id}`)
  console.log(`\nApply it with:\n  spinuptui samurai apply ${p.id} --hash ${p.hash}`)
}

async function proposeCmd(id: string | undefined, json: boolean): Promise<number> {
  if (!id) return fail(json, "usage", USAGE)
  const todo = readLedger().items.get(id.toUpperCase())
  if (!todo) return fail(json, "unknown_todo", `No to-do "${id}".`)
  if (!todo.scope.startsWith("site:")) return fail(json, "not_a_site", `${todo.id} isn't about one site.`)
  const target = await targetFor(todo.scope.slice(5), json)
  if (typeof target === "number") return target
  const r = await propose({ todo, target, by: operator() }, progress)
  if (!r.ok) return fail(json, r.reason, r.message, r.remedy)
  if (json) console.log(JSON.stringify({ ok: true, proposal: r.proposal, alreadyInEffect: r.alreadyInEffect }))
  else printProposal(r.proposal, r.alreadyInEffect)
  return 0
}

function printOutcome(r: ApplyOutcome, json: boolean, done: string): number {
  if (json) {
    console.log(JSON.stringify(r))
    return r.ok ? 0 : 1
  }
  for (const v of r.verification ?? []) console.log(`  ${v.ok ? "✓" : "✗"} ${v.label} (got ${v.got})`)
  if (!r.ok) return fail(false, r.reason, r.message, r.remedy)
  console.log(done)
  return 0
}

async function applyCmd(id: string | undefined, p: Parsed, json: boolean): Promise<number> {
  const hash = p.flags.get("--hash")
  if (!id || !hash) return fail(json, "usage", `Pass the proposal and its hash, as \`samurai propose\` prints them.\n\n${USAGE}`)
  const proposal = loadProposal(id)
  if (!proposal) return fail(json, "unknown_proposal", `No proposal ${id}.`)
  const target = await targetFor(proposal.domain, json)
  if (typeof target === "number") return target
  const todo = readLedger().items.get(proposal.todoId)
  const r = await applyProposal(id, hash, todo, { target, by: operator(), page }, progress)
  return printOutcome(r, json, `Applied. ${proposal.todoId} is done; roll it back with: spinuptui samurai rollback ${id}`)
}

async function rollbackCmd(id: string | undefined, json: boolean): Promise<number> {
  if (!id) return fail(json, "usage", USAGE)
  const proposal = loadProposal(id)
  if (!proposal) return fail(json, "unknown_proposal", `No proposal ${id}.`)
  const target = await targetFor(proposal.domain, json)
  if (typeof target === "number") return target
  const r = await rollbackProposal(id, { target, by: operator() }, progress)
  return printOutcome(r, json, `Rolled back. ${proposal.todoId} is open again.`)
}

function listCmd(json: boolean): number {
  const all = listProposals()
  if (json) {
    console.log(JSON.stringify({ ok: true, proposals: all.map(({ previous: _p, file: _f, diff: _d, ...rest }) => rest) }))
    return 0
  }
  if (!all.length) console.log("No proposals yet.")
  for (const p of all) console.log(`${p.id}  ${p.status.padEnd(11)} ${p.todoId.padEnd(6)} ${p.domain}  ${p.template}${p.error ? `  (${p.error})` : ""}`)
  return 0
}

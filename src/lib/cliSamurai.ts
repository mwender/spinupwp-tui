// `spinuptui samurai …`: the CLI over Samurai. Headless like every module
// command: --json prints one result object on stdout, progress goes to
// stderr, failures use the { ok: false, reason, message, remedy? } shape and
// exit 1.

import { loadConfig } from "../config.ts"
import { SpinupWPClient } from "../api/client.ts"
import { resolveSiteByDomain } from "./cliSsh.ts"
import { getSudoPassword } from "./keychain.ts"
import { applySetup, planSetup, type SetupContext, type SetupPlan } from "./samurai/setup.ts"

export const USAGE = `Usage:
  spinuptui samurai setup <domain> [--server <name>] --plan | --apply [--json]
                           check the server, install the spinuptui-nginx gate,
                           register the site, copy its nginx config here and
                           prove the path end to end. --plan changes nothing.

Setup's one root step uses the server's sudo user and the password SpinupTUI
saved in the Keychain: connect sudo with S on the server in the Servers tab and
tick "remember" first.`

export const VALUE_FLAGS = new Set(["--server"])

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

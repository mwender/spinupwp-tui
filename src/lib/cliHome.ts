// `spinuptui home`: where the SpinupTUI folder is and whether it's shared, and
// `home sync`, which shares it across machines (lib/home.ts). Headless like the
// module commands: --json prints one object on stdout.

import { applySync, describeShare, ensureHome, homeStatus, planSync, tilde, type SyncOptions } from "./home.ts"

const USAGE = `Usage:
  spinuptui home [--json]          where the SpinupTUI folder is, and whether it's shared
  spinuptui home sync --plan | --apply [--json]
        --github <name>            create a private GitHub repository for it (needs gh)
        --remote <url>             or push it to an empty private repository you made
        --clone <url>              on another machine: set the same folder up here

The SpinupTUI folder (~/SpinupTUI) holds your Scheduler jobs and reports and,
later, other modules' work. Shared through a private git repository, you can
queue jobs from any machine and read the reports anywhere.`

const VALUE_FLAGS = new Set(["--github", "--remote", "--clone"])

function fail(json: boolean, reason: string, message: string, remedy?: string): number {
  if (json) console.log(JSON.stringify({ ok: false, reason, message, ...(remedy ? { remedy } : {}) }))
  else {
    console.error(message)
    if (remedy) console.error(remedy)
  }
  return 1
}

export async function runHome(argv: string[]): Promise<number> {
  const flags = new Map<string, string>()
  const pos: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (VALUE_FLAGS.has(a)) flags.set(a, argv[++i] ?? "")
    else if (a.startsWith("-")) flags.set(a, "")
    else pos.push(a)
  }
  const json = flags.has("--json")
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE)
    return 0
  }
  if (pos.length === 0) return status(json)
  if (pos[0] === "sync") return sync(flags, json)
  return fail(json, "usage", USAGE)
}

async function status(json: boolean): Promise<number> {
  const s = await homeStatus()
  if (json) {
    console.log(JSON.stringify({ ok: true, ...s }))
    return 0
  }
  console.log(`SpinupTUI folder: ${tilde(s.path)}${s.exists ? "" : " (created the first time a module writes to it)"}`)
  console.log(`  ${s.git && s.remote ? "✓" : "·"} ${describeShare(s)}`)
  if (s.station) console.log(`  · its jobs run on ${s.station === s.thisMachine ? "this machine" : s.station}`)
  if (s.syncedBy) console.log(`  ✗ inside ${s.syncedBy}: ${s.git ? "two programs syncing the same .git can corrupt it. Move it (homeDir in config.json)." : "fine on its own, but move it before sharing it with git."}`)
  if (!s.git && !s.insideRepo) console.log(`\nTo queue jobs from other machines: spinuptui home sync --plan`)
  return 0
}

async function sync(flags: Map<string, string>, json: boolean): Promise<number> {
  const apply = flags.has("--apply")
  if (apply === flags.has("--plan")) return fail(json, "usage", "Pass --plan to see what would happen, or --apply to do it.\n\n" + USAGE)
  const opts: SyncOptions = {}
  for (const [flag, key] of [
    ["--github", "github"],
    ["--remote", "remote"],
    ["--clone", "clone"],
  ] as const) {
    if (!flags.has(flag)) continue
    if (!flags.get(flag)) return fail(json, "usage", `${flag} needs a value.`)
    opts[key] = flags.get(flag)
  }
  const plan = await planSync(opts)
  if (plan.blockers.length) {
    const b = plan.blockers[0]!
    if (json) console.log(JSON.stringify({ ok: false, reason: b.reason, message: b.message, ...(b.remedy ? { remedy: b.remedy } : {}), blockers: plan.blockers }))
    else for (const x of plan.blockers) fail(false, x.reason, x.message, x.remedy)
    return 1
  }
  const steps = plan.steps.map((s) => s.label)
  if (!apply) {
    if (json) console.log(JSON.stringify({ ok: true, applied: false, mode: plan.mode, home: plan.home, steps, notes: plan.notes }))
    else if (!steps.length) console.log(`${tilde(plan.home)} is already shared and up to date. Nothing to do.`)
    else {
      console.log(`Plan for ${tilde(plan.home)}:`)
      steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`))
      for (const n of plan.notes) console.log(`\n${n}`)
      console.log(`\nRun with --apply to do it.`)
    }
    return 0
  }
  const r = await applySync(plan)
  if (json) console.log(JSON.stringify({ ok: r.ok, applied: true, mode: plan.mode, home: plan.home, done: r.done, ...(r.failed ? { failed: r.failed } : {}) }))
  else {
    for (const d of r.done) console.log(`✓ ${d}`)
    if (r.failed) console.error(`✗ ${r.failed.step}: ${r.failed.message}\nSteps above it are done; fix this and run it again, and it picks up where it stopped.`)
    else if (steps.length) {
      // A clone brings the other machine's README; make sure there is one.
      ensureHome()
      const s = await homeStatus()
      console.log(`\n${tilde(s.path)} is ${describeShare(s)}.`)
    } else console.log(`${tilde(plan.home)} is already shared and up to date. Nothing to do.`)
  }
  return r.ok ? 0 : 1
}

#!/usr/bin/env bun
// Entry point. Handles the non-interactive CLI subcommands, then hands off to
// the dashboard (ui/main.tsx).

// First, before any config read or spawn: keep a site checkout's .env from
// leaking into child processes (see the module).
import "./lib/cwdDotenv.ts"
// Nothing UI-related is imported statically: headless commands (the Scheduler
// tick every 5 minutes, beacon send, incidents…) never load the renderer or
// React. The dashboard is a dynamic import at the bottom.
import pkg from "../package.json" with { type: "json" }
import { configPath, loadConfig, listProfiles } from "./config.ts"
import { SpinupWPClient } from "./api/client.ts"
import { resolveSshAccess } from "./lib/cliSsh.ts"
import { resolveIncidents } from "./lib/cliIncidents.ts"
import { resolveSiblings } from "./lib/cliSiblings.ts"
import { execSshCommand } from "./lib/sshExec.ts"
import { runPullFiles, runPullDb } from "./lib/cliPull.ts"
import { runBeacon, runModules } from "./lib/cliBeacon.ts"
import { runOffline, runOnline } from "./lib/cliOffline.ts"
import { runScheduler } from "./lib/cliScheduler.ts"
import { nearCommands, renderCommandList } from "./lib/cliCommands.ts"

const args = process.argv.slice(2)
const positionals = args.filter((a) => !a.startsWith("-"))
const command = positionals[0]

// Flags that take a following value. Listed so that value can be skipped when
// collecting positionals — otherwise `--server web1 <domain>` reads "web1" as
// the domain, and a URL (which doesn't look like a flag) reads as a path.
const VALUE_FLAGS = new Set(["--url", "--server"])

function parseFlags(list: string[]): { positionals: string[]; flags: Map<string, string> } {
  const out: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) {
        flags.set(a, list[i + 1] ?? "")
        i++
      } else {
        flags.set(a, "")
      }
      continue
    }
    out.push(a)
  }
  return { positionals: out, flags }
}

// A value-taking flag with nothing usable after it is a mistake worth naming,
// not a silently-empty value.
function badFlagValue(flags: Map<string, string>, name: string): boolean {
  if (!flags.has(name)) return false
  const v = flags.get(name)!
  return !v || v.startsWith("-")
}

// Shell completion comes first: the words being completed can include -h or
// anything else the checks below would act on.
if (args[0] === "__complete") {
  const { complete, formatCompletion, resolveFromDisk } = await import("./lib/cliComplete.ts")
  process.stdout.write(formatCompletion(await complete(args.slice(1), resolveFromDisk)))
  process.exit(0)
}

if (command === "completion") {
  const { completionScript, COMPLETION_HELP } = await import("./lib/cliComplete.ts")
  const shell = args[args.indexOf("completion") + 1]
  const script = shell && !shell.startsWith("-") ? completionScript(shell) : null
  if (!script) {
    ;(args.includes("-h") || args.includes("--help") ? console.log : console.error)(COMPLETION_HELP)
    process.exit(args.includes("-h") || args.includes("--help") ? 0 : 1)
  }
  process.stdout.write(script)
  process.exit(0)
}

if (args.includes("-h") || args.includes("--help") || command === "help") {
  const cfg = loadConfig()
  console.log(`SpinupTUI v${pkg.version} — terminal dashboard for your SpinupWP account

Usage:
${renderCommandList()}

--server picks one site when a domain exists on more than one server (the
ambiguity message lists them); it works on ssh, ssh-exec and both pull
commands. Add --json to either pull command for a single
machine-readable result object on stdout; progress always goes to stderr, so a
long pull never looks hung.

Token resolution: SPINUPWP_ACCESS_TOKEN (env / .env) first, then the config
file. Run \`spinuptui login\` once to save a token so \`spinuptui\` works from
anywhere.

Accounts: add and switch SpinupWP accounts in the app with A. Commands use the
active one; SPINUPTUI_ACCOUNT=<id> picks another for a single run (ids are
listed by \`spinuptui where\`).

Config file: ${configPath()}
Account: ${cfg.profileLabel} (${cfg.profileId})
Token source: ${cfg.tokenSource}`)
  process.exit(0)
}

if (args.includes("-v") || args.includes("--version") || command === "version") {
  console.log(pkg.version)
  process.exit(0)
}

if (command === "where") {
  const cfg = loadConfig()
  console.log(`config: ${configPath()}`)
  console.log(`account: ${cfg.profileLabel} (${cfg.profileId})`)
  console.log(`token source: ${cfg.tokenSource}`)
  const others = listProfiles().filter((p) => !p.active)
  if (others.length) console.log(`other accounts: ${others.map((p) => `${p.label} (${p.id})`).join(", ")}`)
  process.exit(0)
}

if (command === "ssh") {
  const parsed = parseFlags(args.slice(1))
  const domain = parsed.positionals[0]
  const server = parsed.flags.get("--server") ?? null
  if (!domain || badFlagValue(parsed.flags, "--server")) {
    console.error(
      JSON.stringify({ ok: false, reason: "usage", message: "Usage: spinuptui ssh <domain> [--server <name>]" }),
    )
    process.exit(1)
  }
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  const result = await resolveSshAccess(domain, client, cfg, { server })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

if (command === "ssh-exec") {
  const dashIdx = args.indexOf("--")
  // Only the arguments BEFORE `--` are ours; everything after is the remote
  // command, which may legitimately contain things that look like our flags.
  const parsed = parseFlags(dashIdx === -1 ? args.slice(1) : args.slice(1, dashIdx))
  const domain = parsed.positionals[0]
  const server = parsed.flags.get("--server") ?? null
  const remoteCmd = dashIdx !== -1 ? args.slice(dashIdx + 1).join(" ") : ""
  if (!domain || dashIdx === -1 || !remoteCmd.trim() || badFlagValue(parsed.flags, "--server")) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: "usage",
        message: "Usage: spinuptui ssh-exec <domain> [--server <name>] -- <command>",
      }),
    )
    process.exit(1)
  }
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  const result = await execSshCommand(domain, remoteCmd, client, cfg, { server })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

if (command === "siblings") {
  const parsed = parseFlags(args.slice(1))
  const domain = parsed.positionals[0]
  const server = parsed.flags.get("--server") ?? null
  const probe = parsed.flags.has("--probe")
  if (!domain || badFlagValue(parsed.flags, "--server")) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: "usage",
        message: "Usage: spinuptui siblings <domain> [--server <name>] [--probe]",
      }),
    )
    process.exit(1)
  }
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  const result = await resolveSiblings(domain, client, cfg, { server, probe })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

if (command === "incidents") {
  const rest = args.slice(1)
  const hoursIdx = rest.indexOf("--hours")
  const hours = hoursIdx !== -1 ? Number(rest[hoursIdx + 1]) : 24
  const allFlag = rest.includes("--all")
  const domainArg = rest.find((a, i) => !a.startsWith("-") && !(hoursIdx !== -1 && i === hoursIdx + 1))

  if ((!domainArg && !allFlag) || (domainArg && allFlag) || !Number.isFinite(hours) || hours <= 0) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: "usage",
        message: "Usage: spinuptui incidents <domain> | spinuptui incidents --all [--hours N]",
      }),
    )
    process.exit(1)
  }
  const cfg = loadConfig()
  const result = await resolveIncidents(cfg, { domain: domainArg, hours })
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

if (command === "pull") {
  const { positionals: pos, flags } = parseFlags(args.slice(1))
  const json = flags.has("--json")
  const yes = flags.has("--yes")
  const url = flags.get("--url") ?? null
  const server = flags.get("--server") ?? null
  const sub = pos[0]
  const domain = pos[1]
  const destPath = pos[2] ?? null

  const usage = (message: string) => {
    console.error(JSON.stringify({ ok: false, reason: "usage", message }))
    process.exit(1)
  }

  if (sub !== "files" && sub !== "db") {
    usage("Usage: spinuptui pull files <domain> [path] [--url <local url>] | spinuptui pull db <domain> [--url <local url>] --yes")
  }
  if (!domain) usage(`Usage: spinuptui pull ${sub} <domain>`)
  if (badFlagValue(flags, "--url")) usage("--url needs a value, e.g. --url https://example.test")
  if (badFlagValue(flags, "--server")) usage("--server needs a value, e.g. --server web1.example.com")
  if (sub === "db" && destPath) usage("`pull db` imports into the already-linked copy and takes no path. Use --url to set the local URL.")

  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  // Progress is a human channel on stderr in both modes: it keeps a long rsync
  // from looking hung, and leaves stdout as the machine contract.
  const onStage = (line: string) => process.stderr.write(`\u2192 ${line}\n`)

  const result =
    sub === "files"
      ? await runPullFiles(domain!, { path: destPath, url, server }, client, cfg, onStage)
      : await runPullDb(domain!, { url, yes, server }, client, cfg, onStage)

  if (json) {
    console.log(JSON.stringify(result))
  } else if (result.ok) {
    if (result.command === "pull files") {
      const built = result.ranComposer ? ", composer install ran" : ""
      console.log(`Pulled ${result.primaryDomain} to ${result.path} (${result.method}${built}) and linked it.`)
      console.log(
        result.localUrl
          ? `Next: spinuptui pull db ${result.primaryDomain} --yes`
          : `Next: spinuptui pull db ${result.primaryDomain} --url <local url> --yes`,
      )
    } else {
      console.log(`Imported production's database for ${result.primaryDomain} into ${result.path}.`)
      console.log(`Local database backed up first to ${result.localBackupPath}`)
    }
    for (const warning of result.warnings ?? []) console.error(`Warning: ${warning}`)
  } else {
    console.error(result.message)
    for (const c of result.candidates ?? []) console.error(`  · ${c.server} (site ${c.siteId})`)
    if (result.remedy) console.error(result.remedy)
  }
  process.exit(result.ok ? 0 : 1)
}

if (command === "offline") {
  process.exit(await runOffline(args.slice(args.indexOf("offline") + 1)))
}

if (command === "online") {
  process.exit(await runOnline(args.slice(args.indexOf("online") + 1)))
}

if (command === "beacon") {
  process.exit(await runBeacon(args.slice(args.indexOf("beacon") + 1)))
}

if (command === "modules") {
  process.exit(await runModules(args.slice(1)))
}

if (command === "home") {
  const { runHome } = await import("./lib/cliHome.ts")
  process.exit(await runHome(args.slice(args.indexOf("home") + 1)))
}

if (command === "scheduler") {
  process.exit(await runScheduler(args.slice(args.indexOf("scheduler") + 1)))
}

if (command === "todos") {
  const { runTodos } = await import("./lib/cliTodos.ts")
  process.exit(await runTodos(args.slice(args.indexOf("todos") + 1)))
}

if (command === "samurai") {
  const { runSamurai } = await import("./lib/cliSamurai.ts")
  process.exit(await runSamurai(args.slice(args.indexOf("samurai") + 1)))
}

if (command === "sentinel") {
  const { runSentinel } = await import("./lib/cliSentinel.ts")
  process.exit(await runSentinel(args.slice(args.indexOf("sentinel") + 1)))
}

// Anything else on the command line is a mistake: a typo, or a command from a
// newer release. Say so rather than launch the dashboard, which looks like a
// hang when the caller is a script or a shell's rc file.
if (command && command !== "login") {
  const near = nearCommands(command)
  console.error(`spinuptui: unknown command "${command}".${near.length ? ` Did you mean ${near.map((n) => `\`${n}\``).join(" or ")}?` : ""}`)
  console.error(`Run \`spinuptui -h\` for the list (this is v${pkg.version}; a newer release may have it).`)
  process.exit(1)
}

// `spinuptui login` forces the onboarding wizard even when a token already exists,
// so the token can be (re)saved to the config file for global use.
const { startDashboard } = await import("./ui/main.tsx")
await startDashboard({ forceLogin: command === "login" })

#!/usr/bin/env bun
// Entry point. Handles a few non-interactive CLI subcommands, then boots the
// OpenTUI renderer and mounts either the first-run onboarding wizard (no token
// yet) or the main app wrapped in the data store.

import { useState } from "react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import pkg from "../package.json" with { type: "json" }
import { hasToken, configPath, loadConfig } from "./config.ts"
import { StoreProvider } from "./ui/store.tsx"
import { App } from "./ui/App.tsx"
import { Onboarding } from "./ui/Onboarding.tsx"
import { isDevMode } from "./dev/devMode.ts"
import { SpinupWPClient } from "./api/client.ts"
import { resolveSshAccess } from "./lib/cliSsh.ts"
import { resolveIncidents } from "./lib/cliIncidents.ts"
import { execSshCommand } from "./lib/sshExec.ts"
import { runPullFiles, runPullDb } from "./lib/cliPull.ts"

const args = process.argv.slice(2)
const positionals = args.filter((a) => !a.startsWith("-"))
const command = positionals[0]

if (args.includes("-h") || args.includes("--help") || command === "help") {
  const cfg = loadConfig()
  console.log(`SpinupTUI v${pkg.version} — terminal dashboard for your SpinupWP account

Usage:
  spinuptui            Launch the dashboard
  spinuptui login      Set or update your saved API token
  spinuptui where      Print the config file path and token source
  spinuptui ssh <domain>  Print SSH access info for a site (JSON)
  spinuptui ssh-exec <domain> -- <command>  Run a read-only command over SSH
                       (JSON); denies anything that looks like a remote write
  spinuptui incidents <domain> | --all [--hours N]  Print Uptime Kuma
                       down/up incidents for a site or the whole fleet (JSON)
  spinuptui pull files <domain> [path] [--url <local url>]
                       Clone a site's code to a new local working copy and link
                       it. Read-only on production; refuses a non-empty path.
                       With exactly one localRoots entry configured, the path
                       defaults to <that root>/<domain>.
  spinuptui pull db <domain> [--url <local url>] --yes
                       Import production's database into the linked local copy,
                       rewriting URLs. OVERWRITES your local database: needs
                       both --yes and "localSync": true in the config.
  spinuptui --version  Print the version
  spinuptui --help     Show this help

Add --json to either pull command for a single machine-readable result object
on stdout; progress always goes to stderr, so a long pull never looks hung.

Token resolution: SPINUPWP_ACCESS_TOKEN (env / .env) first, then the config
file. Run \`spinuptui login\` once to save a token so \`spinuptui\` works from
anywhere.

Config file: ${configPath()}
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
  console.log(`token source: ${cfg.tokenSource}`)
  process.exit(0)
}

if (command === "ssh") {
  const domain = positionals[1]
  if (!domain) {
    console.error(JSON.stringify({ ok: false, reason: "usage", message: "Usage: spinuptui ssh <domain>" }))
    process.exit(1)
  }
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  const result = await resolveSshAccess(domain, client, cfg)
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
}

if (command === "ssh-exec") {
  const dashIdx = args.indexOf("--")
  const domain = positionals[1]
  const remoteCmd = dashIdx !== -1 ? args.slice(dashIdx + 1).join(" ") : ""
  if (!domain || dashIdx === -1 || !remoteCmd.trim()) {
    console.error(
      JSON.stringify({ ok: false, reason: "usage", message: "Usage: spinuptui ssh-exec <domain> -- <command>" }),
    )
    process.exit(1)
  }
  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  const result = await execSshCommand(domain, remoteCmd, client, cfg)
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
  const rest = args.slice(1)
  const json = rest.includes("--json")
  const yes = rest.includes("--yes")
  const urlIdx = rest.indexOf("--url")
  const url = urlIdx !== -1 ? (rest[urlIdx + 1] ?? null) : null
  // Positionals, skipping flags and the value that belongs to --url (which is a
  // URL, so it doesn't look like a flag and would otherwise be read as a path).
  const pos: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a.startsWith("-")) {
      if (a === "--url") i++
      continue
    }
    pos.push(a)
  }
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
  if (urlIdx !== -1 && (!url || url.startsWith("-"))) usage("--url needs a value, e.g. --url https://example.test")
  if (sub === "db" && destPath) usage("`pull db` imports into the already-linked copy and takes no path. Use --url to set the local URL.")

  const cfg = loadConfig()
  const client = new SpinupWPClient(cfg)
  // Progress is a human channel on stderr in both modes: it keeps a long rsync
  // from looking hung, and leaves stdout as the machine contract.
  const onStage = (line: string) => process.stderr.write(`\u2192 ${line}\n`)

  const result =
    sub === "files"
      ? await runPullFiles(domain!, { path: destPath, url }, client, cfg, onStage)
      : await runPullDb(domain!, { url, yes }, client, cfg, onStage)

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
    if (result.remedy) console.error(result.remedy)
  }
  process.exit(result.ok ? 0 : 1)
}

// `spinuptui login` forces the onboarding wizard even when a token already exists,
// so the token can be (re)saved to the config file for global use.
const forceLogin = command === "login"

function Root() {
  const [configured, setConfigured] = useState(isDevMode() ? true : forceLogin ? false : hasToken())
  if (!configured) {
    return <Onboarding onComplete={() => setConfigured(true)} />
  }
  return (
    <StoreProvider>
      <App />
    </StoreProvider>
  )
}

const renderer = await createCliRenderer()
createRoot(renderer).render(<Root />)

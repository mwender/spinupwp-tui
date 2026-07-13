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
  spinuptui --version  Print the version
  spinuptui --help     Show this help

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

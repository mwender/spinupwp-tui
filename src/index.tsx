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

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith("-"))

if (args.includes("-h") || args.includes("--help") || command === "help") {
  const cfg = loadConfig()
  console.log(`Spinup v${pkg.version} — terminal dashboard for your SpinupWP account

Usage:
  spinup            Launch the dashboard
  spinup login      Set or update your saved API token
  spinup where      Print the config file path and token source
  spinup --version  Print the version
  spinup --help     Show this help

Token resolution: SPINUPWP_ACCESS_TOKEN (env / .env) first, then the config
file. Run \`spinup login\` once to save a token so \`spinup\` works from anywhere.

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

// `spinup login` forces the onboarding wizard even when a token already exists,
// so the token can be (re)saved to the config file for global use.
const forceLogin = command === "login"

function Root() {
  const [configured, setConfigured] = useState(forceLogin ? false : hasToken())
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

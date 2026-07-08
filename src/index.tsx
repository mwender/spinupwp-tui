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

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith("-"))

if (args.includes("-h") || args.includes("--help") || command === "help") {
  const cfg = loadConfig()
  console.log(`SpinupTUI v${pkg.version} — terminal dashboard for your SpinupWP account

Usage:
  spinuptui            Launch the dashboard
  spinuptui login      Set or update your saved API token
  spinuptui where      Print the config file path and token source
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

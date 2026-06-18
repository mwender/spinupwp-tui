#!/usr/bin/env bun
// Entry point. Boots the OpenTUI renderer and mounts either the first-run
// onboarding wizard (no token yet) or the main app wrapped in the data store.

import { useState } from "react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { hasToken } from "./config.ts"
import { StoreProvider } from "./ui/store.tsx"
import { App } from "./ui/App.tsx"
import { Onboarding } from "./ui/Onboarding.tsx"

function Root() {
  // Re-check token presence after onboarding completes to flip into the app.
  const [configured, setConfigured] = useState(hasToken())
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

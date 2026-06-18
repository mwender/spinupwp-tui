// Application shell: splash gating, global key routing, header/content/status layout.

import { useEffect, useState } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { theme } from "../lib/theme.ts"
import { useStore } from "./store.tsx"
import { Splash } from "./Splash.tsx"
import { Header } from "./Header.tsx"
import { HelpOverlay } from "./Help.tsx"
import { Dashboard } from "./views/Dashboard.tsx"
import { Browser } from "./views/Browser.tsx"
import { Search } from "./views/Search.tsx"
import { Events } from "./views/Events.tsx"

const MIN_SPLASH_MS = 1200

export function App() {
  const store = useStore()
  const renderer = useRenderer()
  const { height } = useTerminalDimensions()
  const [splashDone, setSplashDone] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  // Enforce a minimum splash duration so the intro is visible even on fast loads.
  useEffect(() => {
    const id = setTimeout(() => setSplashDone(true), MIN_SPLASH_MS)
    return () => clearTimeout(id)
  }, [])

  // Keep views aware that a modal is open so they pause their own key handling.
  useEffect(() => {
    store.setOverlayOpen(showHelp)
  }, [showHelp, store])

  function quit() {
    try {
      renderer.destroy?.()
    } catch {
      // ignore — we're exiting anyway
    }
    process.exit(0)
  }

  useKeyboard((key) => {
    // Ctrl+C always quits, even while typing.
    if (key.ctrl && key.name === "c") return quit()

    // While a text field is focused, let it consume everything else.
    if (store.inputMode) return

    if (showHelp) {
      if (key.name === "escape" || key.name === "q" || key.name === "?") setShowHelp(false)
      return
    }

    switch (key.name) {
      case "q":
        return quit()
      case "1":
        return store.setRoute("dashboard")
      case "2":
        return store.setRoute("servers")
      case "3":
        return store.setRoute("search")
      case "4":
        return store.setRoute("events")
      case "r":
        return void store.refresh()
      case "?":
        return setShowHelp(true)
      case "/":
        return store.setRoute("search")
    }
  })

  // Splash until the minimum time has elapsed AND the first data load resolved.
  if (!splashDone || !store.ready) {
    const status = store.error
      ? "Trouble reaching SpinupWP — entering anyway…"
      : store.loading
        ? "Fetching your servers and sites…"
        : "Ready."
    return <Splash status={status} />
  }

  // Rows available to the content area: total minus the header row. Each view
  // renders its own status bar, so it subtracts that itself.
  const contentRows = Math.max(3, height - 1)

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg }}>
      <Header />
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        {store.route === "dashboard" && <Dashboard rows={contentRows} />}
        {store.route === "servers" && <Browser rows={contentRows} />}
        {store.route === "search" && <Search rows={contentRows} />}
        {store.route === "events" && <Events rows={contentRows} />}
      </box>
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </box>
  )
}

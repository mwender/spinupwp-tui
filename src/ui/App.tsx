// Application shell: splash gating, global key routing, header/content/status layout.

import { useEffect, useState } from "react"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { theme } from "../lib/theme.ts"
import { useStore } from "./store.tsx"
import { Splash } from "./Splash.tsx"
import { Header } from "./Header.tsx"
import { HelpOverlay } from "./Help.tsx"
import { ExplainOverlay } from "./Explain.tsx"
import { Dashboard } from "./views/Dashboard.tsx"
import { Browser } from "./views/Browser.tsx"
import { Stacks } from "./views/Stacks.tsx"
import { Search } from "./views/Search.tsx"
import { Events } from "./views/Events.tsx"
import { Health } from "./views/Health.tsx"
import { PhpUpgrade } from "./views/PhpUpgrade.tsx"
import { ServerActions } from "./views/ServerActions.tsx"
import { LocalLinkOverlay } from "./views/LocalLink.tsx"
import { Discover } from "./views/Discover.tsx"
import { Forgotten } from "./views/Forgotten.tsx"
import { DnsInventory } from "./views/DnsInventory.tsx"
import { ProviderConnect } from "./views/ProviderConnect.tsx"
import { DnsRecords } from "./views/DnsRecords.tsx"

const MIN_SPLASH_MS = 1200

export function App() {
  const store = useStore()
  const renderer = useRenderer()
  const { height } = useTerminalDimensions()
  const [splashDone, setSplashDone] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showExplain, setShowExplain] = useState(false)

  // Enforce a minimum splash duration so the intro is visible even on fast loads.
  useEffect(() => {
    const id = setTimeout(() => setSplashDone(true), MIN_SPLASH_MS)
    return () => clearTimeout(id)
  }, [])

  // Keep views aware that a modal is open so they pause their own key handling.
  const overlayActive =
    showHelp ||
    showExplain ||
    store.healthServer !== null ||
    store.phpUpgradeSite !== null ||
    store.serverActionsServer !== null ||
    store.localLinkSite !== null ||
    store.discoverOpen ||
    store.forgottenOpen ||
    store.dnsInventoryServer !== null ||
    store.connectZoneTarget !== null ||
    store.dnsRecordsTarget !== null
  useEffect(() => {
    store.setOverlayOpen(overlayActive)
  }, [overlayActive, store])

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

    // The health overlay owns the keyboard while open (it handles Esc/q/r/h).
    if (store.healthServer) return

    // The PHP-upgrade overlay owns the keyboard while open.
    if (store.phpUpgradeSite) return

    // The server-actions overlay owns the keyboard while open.
    if (store.serverActionsServer) return

    // The local-link overlay owns the keyboard while open.
    if (store.localLinkSite) return

    // The discovery overlay owns the keyboard while open.
    if (store.discoverOpen) return

    // The "needs a local copy" report owns the keyboard while open.
    if (store.forgottenOpen) return

    // The DNS inventory overlay owns the keyboard while open.
    if (store.dnsInventoryServer) return

    // The provider-connect overlay owns the keyboard while open.
    if (store.connectZoneTarget) return

    // The DNS-records overlay owns the keyboard while open.
    if (store.dnsRecordsTarget) return

    if (showHelp) {
      if (key.name === "escape" || key.name === "q" || key.name === "?") setShowHelp(false)
      return
    }

    if (showExplain) {
      if (key.name === "escape" || key.name === "q" || key.name === "i") setShowExplain(false)
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
        return store.setRoute("stacks")
      case "4":
        return store.setRoute("search")
      case "5":
        return store.setRoute("events")
      case "r":
        return void store.refresh()
      case "?":
        return setShowHelp(true)
      case "i":
        return setShowExplain(true)
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

  // Rows available to the content area: total minus the header (nav + subtitle =
  // 2 rows) and the error banner, when present. Each view renders its own status bar.
  const contentRows = Math.max(3, height - 2 - (store.error ? 1 : 0))

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg }}>
      <Header />
      {store.error && (
        <box style={{ height: 1, backgroundColor: theme.bad, paddingLeft: 1, paddingRight: 1, flexDirection: "row" }}>
          <text content={`⚠ ${store.error}  —  press r to retry`} fg={theme.bg} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
        </box>
      )}
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        {store.route === "dashboard" && <Dashboard rows={contentRows} />}
        {store.route === "servers" && <Browser rows={contentRows} />}
        {store.route === "stacks" && <Stacks rows={contentRows} />}
        {store.route === "search" && <Search rows={contentRows} />}
        {store.route === "events" && <Events rows={contentRows} />}
      </box>
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      {showExplain && <ExplainOverlay route={store.route} />}
      {store.healthServer && <Health />}
      {store.phpUpgradeSite && <PhpUpgrade />}
      {store.serverActionsServer && <ServerActions />}
      {store.localLinkSite && <LocalLinkOverlay />}
      {store.discoverOpen && <Discover />}
      {store.forgottenOpen && <Forgotten />}
      {store.dnsInventoryServer && <DnsInventory />}
      {store.connectZoneTarget && <ProviderConnect />}
      {store.dnsRecordsTarget && <DnsRecords />}
    </box>
  )
}

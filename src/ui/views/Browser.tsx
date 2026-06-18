// Server & site browser: a three-pane master/detail navigator.
//
//   [ Servers ] → [ Sites on server ] → [ Details of focused item ]
//
// Tab / →  moves focus rightward, ← / Esc moves it back. ↑/↓ (or j/k) move the
// selection in the focused pane. `o` opens the selected site in the browser.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme, statusColor, statusDot } from "../../lib/theme.ts"
import { classifyStack, stackColor, stackTag } from "../../lib/stack.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, PhpVersionCell } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { ServerDetail, SiteDetail } from "../Details.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { openUrl } from "../../lib/open.ts"
import { serverWebUrl, siteWebUrl } from "../../lib/spinupweb.ts"
import { useStore } from "../store.tsx"

type Focus = "servers" | "sites"

export function Browser({ rows }: { rows: number }) {
  const store = useStore()
  const { servers, sitesForServer, route, inputMode, overlayOpen, setHealthServer, runProbe, accountSlug, setPhpUpgradeSite, phpUpgrades } = store

  const [serverIndex, setServerIndex] = useState(0)
  const [siteIndex, setSiteIndex] = useState(0)
  const [focus, setFocus] = useState<Focus>("servers")
  const [flash, setFlash] = useState<string | null>(null)

  // Servers sorted alphabetically for predictable browsing.
  const sortedServers = useMemo(
    () => [...servers].sort((a, b) => a.name.localeCompare(b.name)),
    [servers],
  )
  const server = sortedServers[Math.min(serverIndex, sortedServers.length - 1)]
  const sites = useMemo(
    () => (server ? [...sitesForServer(server.id)].sort((a, b) => a.domain.localeCompare(b.domain)) : []),
    [server, sitesForServer],
  )

  // Reset site selection whenever the active server changes.
  useEffect(() => {
    setSiteIndex(0)
  }, [serverIndex])

  const isActive = route === "servers" && !inputMode && !overlayOpen

  useKeyboard((key) => {
    if (!isActive) return
    // OpenTUI lowercases letters and sets a shift flag; normalize so capital
    // shortcuts (e.g. G = jump to bottom) match.
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw

    const moveBy = (delta: number) => {
      if (focus === "servers") setServerIndex((i) => moveSelection(i, delta, sortedServers.length))
      else setSiteIndex((i) => moveSelection(i, delta, sites.length))
    }

    switch (name) {
      case "up":
      case "k":
        return moveBy(-1)
      case "down":
      case "j":
        return moveBy(1)
      case "g":
        return focus === "servers" ? setServerIndex(0) : setSiteIndex(0)
      case "G":
        return focus === "servers" ? setServerIndex(sortedServers.length - 1) : setSiteIndex(sites.length - 1)
      case "right":
      case "l":
      case "return":
      case "tab":
        if (focus === "servers" && sites.length > 0) setFocus("sites")
        return
      case "left":
      case "escape":
        if (focus === "sites") setFocus("servers")
        return
      case "o":
        if (focus === "sites" && sites[siteIndex]) {
          const s = sites[siteIndex]
          openUrl((s.https?.enabled ? "https://" : "http://") + s.domain)
          setFlash(`Opening ${s.domain}…`)
          setTimeout(() => setFlash(null), 1500)
        }
        return
      case "d":
        // Detect the selected site's stack via SSH (Tier 2); shows in Details.
        if (focus === "sites" && sites[siteIndex]) {
          const s = sites[siteIndex]
          runProbe(s)
          setFlash(`Probing ${s.domain}…`)
          setTimeout(() => setFlash(null), 1500)
        }
        return
      case "u":
        // Upgrade the selected site's PHP version (first write action).
        if (focus === "sites" && sites[siteIndex]) setPhpUpgradeSite(sites[siteIndex])
        return
      case "h":
        // Open the live health view for the current server (works from either pane).
        if (server) setHealthServer(server)
        return
      case "w":
        // Open the focused server/site in the SpinupWP web app — useful for
        // actions the API can't do (e.g. running a pending server upgrade).
        if (focus === "sites" && sites[siteIndex]) {
          openUrl(siteWebUrl(sites[siteIndex].id, accountSlug))
          setFlash(accountSlug ? "Opening in SpinupWP…" : "Set accountSlug for deep links — opening dashboard")
        } else if (server) {
          openUrl(serverWebUrl(server.id, accountSlug))
          setFlash(accountSlug ? "Opening in SpinupWP…" : "Set accountSlug for deep links — opening dashboard")
        }
        setTimeout(() => setFlash(null), 2000)
        return
    }
  })

  const listRows = Math.max(3, rows - 6)
  const focusedSite = sites[Math.min(siteIndex, Math.max(0, sites.length - 1))]

  const hints =
    focus === "servers"
      ? [
          { key: "↑↓/jk", label: "select" },
          { key: "→/⏎", label: "view sites" },
          { key: "h", label: "health" },
          { key: "w", label: "open in SpinupWP" },
        ]
      : [
          { key: "↑↓/jk", label: "select site" },
          { key: "←/esc", label: "back" },
          { key: "d", label: "detect" },
          { key: "u", label: "upgrade PHP" },
          { key: "o", label: "open" },
          { key: "w", label: "SpinupWP" },
          { key: "h", label: "health" },
        ]

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row", padding: 1, gap: 1 }}>
        {/* Servers pane */}
        <Panel title={` Servers (${sortedServers.length}) `} active={focus === "servers"} width={34}>
          <List
            items={sortedServers}
            selectedIndex={serverIndex}
            viewportRows={listRows}
            focused={focus === "servers"}
            keyFor={(s) => s.id}
            emptyText="No servers"
            renderRow={(s, selected) => {
              const count = sitesForServer(s.id).length
              return (
                <>
                  <text content={statusDot(s.connection_status) + " "} fg={statusColor(s.connection_status)} style={{ flexShrink: 0 }} />
                  <text content={truncate(s.name, 22)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  {s.upgrade_required && <text content="⬆upg " fg={selected ? theme.text : theme.warn} style={{ flexShrink: 0 }} />}
                  <text content={" " + count} fg={selected ? theme.text : theme.textFaint} style={{ flexShrink: 0 }} />
                </>
              )
            }}
          />
        </Panel>

        {/* Sites pane */}
        <Panel title={server ? ` Sites · ${truncate(server.name, 20)} (${sites.length}) ` : " Sites "} active={focus === "sites"} flexGrow={1}>
          <List
            items={sites}
            selectedIndex={siteIndex}
            viewportRows={listRows}
            focused={focus === "sites"}
            keyFor={(s) => s.id}
            emptyText="No sites on this server"
            renderRow={(s, selected) => {
              const updates = (s.wp_plugin_updates || 0) + (s.wp_theme_updates || 0) + (s.wp_core_update ? 1 : 0)
              const stack = classifyStack(s)
              return (
                <>
                  <text content={statusDot(s.status) + " "} fg={statusColor(s.status)} style={{ flexShrink: 0 }} />
                  <text content={truncate(s.domain, 40)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  <text content={stackTag(stack) + " "} fg={stackColor(stack, selected)} style={{ flexShrink: 0 }} />
                  {updates > 0 && <text content={`↑${updates} `} fg={theme.warn} style={{ flexShrink: 0 }} />}
                  <PhpVersionCell version={s.php_version} upgrade={phpUpgrades.get(s.id)} selected={selected} />
                </>
              )
            }}
          />
        </Panel>

        {/* Detail pane */}
        <Panel title=" Details " width={44}>
          {focus === "sites" && focusedSite ? (
            <SiteDetail site={focusedSite} serverName={server?.name ?? "—"} />
          ) : server ? (
            <ServerDetail server={server} siteCount={sites.length} />
          ) : (
            <text content="No data" fg={theme.textFaint} />
          )}
        </Panel>
      </box>
      <StatusBar hints={hints} message={flash ?? undefined} messageColor={theme.brand} />
    </box>
  )
}

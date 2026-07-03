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
import { Panel, PhpVersionCell, Spinner, SiteMetaCell } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { ServerDetail, SiteDetail, SiteContextStrip, SITE_CONTEXT_STRIP_HEIGHT } from "../Details.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { openUrl } from "../../lib/open.ts"
import { serverWebUrl, siteWebUrl } from "../../lib/spinupweb.ts"
import { useStore, isServerOpInFlight } from "../store.tsx"

type Focus = "servers" | "sites"

export function Browser({ rows }: { rows: number }) {
  const store = useStore()
  const { servers, sitesForServer, route, inputMode, overlayOpen, setHealthServer, runProbe, accountSlug, setPhpUpgradeSite, phpUpgrades, setHttpsToggleSite, setPurgeCacheSite, setGrantKeySite, setSudoConnectServer, isSudoConnected, grantedKeyKinds, setServerActionsServer, serverOps, setLocalLinkSite, openLocalTerminal, openLocalUrl, localLinks, sshSite, setDnsInventoryServer, setNewServerSource, setNewServerOpen, setVanityServer, vanityJob, beginClone, isServerOsEol, setKumaSite } = store

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
          setFlash(`Identifying the app on ${s.domain}…`)
          setTimeout(() => setFlash(null), 1500)
        }
        return
      case "u":
        // Upgrade the selected site's PHP version (first write action).
        if (focus === "sites" && sites[siteIndex]) setPhpUpgradeSite(sites[siteIndex])
        return
      case "H":
        // Enable/disable HTTPS on the selected site (direction auto-derived).
        if (focus === "sites" && sites[siteIndex]) setHttpsToggleSite(sites[siteIndex])
        return
      case "P":
        // Purge page cache + object cache on the selected site.
        if (focus === "sites" && sites[siteIndex]) setPurgeCacheSite(sites[siteIndex])
        return
      case "m":
        // Uptime Kuma monitoring for the selected site (connect on first use).
        if (focus === "sites" && sites[siteIndex]) setKumaSite(sites[siteIndex])
        return
      case "K":
        // Grant Spinup's machine key to the selected site over SSH (privileged
        // write via the server's sudo user — the API can't do this). Capital K
        // (like L/V/N) since lowercase k is the vim "move up" binding.
        if (focus === "sites" && sites[siteIndex]) setGrantKeySite(sites[siteIndex])
        return
      case "L":
        // Link / view the selected site's local working copy (Phase 1).
        if (focus === "sites" && sites[siteIndex]) setLocalLinkSite(sites[siteIndex])
        return
      case "t":
        // Open the selected site's local working copy in a terminal (inline).
        if (focus === "sites" && sites[siteIndex]) {
          setFlash(openLocalTerminal(sites[siteIndex].id))
          setTimeout(() => setFlash(null), 1800)
        }
        return
      case "v":
        // Open the selected site's stored local URL in the browser.
        if (focus === "sites" && sites[siteIndex]) {
          setFlash(openLocalUrl(sites[siteIndex].id))
          setTimeout(() => setFlash(null), 1800)
        }
        return
      case "s":
        // Open a terminal and SSH into the selected site.
        if (focus === "sites" && sites[siteIndex]) {
          setFlash(sshSite(sites[siteIndex].id))
          setTimeout(() => setFlash(null), 2000)
        }
        return
      case "n":
        // DNS inventory scoped to the selected site (its domains + records).
        if (focus === "sites" && sites[siteIndex] && server) setDnsInventoryServer(server, sites[siteIndex].id)
        return
      case "N":
        // Server-wide DNS inventory — every site on the server.
        if (server) setDnsInventoryServer(server)
        return
      case "S":
        // Connect sudo on the selected server (open a privileged session for the
        // rest of the run — S for Sudo). Server-scoped — works from either pane.
        if (server) setSudoConnectServer(server)
        return
      case "a":
        // Server actions (reboot / restart) are server-scoped, so only offered
        // when the Servers pane is focused — when you've drilled into a site,
        // the context is the site (server actions are dropped there).
        if (focus === "servers" && server) setServerActionsServer(server)
        return
      case "c":
        // Create a new server. Seed from the highlighted server when there is one;
        // open from scratch otherwise (incl. an empty fleet). Servers-pane only.
        if (focus === "servers") {
          setNewServerSource(server ?? null)
          setNewServerOpen(true)
        }
        return
      case "C":
        // Clone this server (all its sites) to a brand-new server. Servers-pane only,
        // and only when the server actually has sites to clone.
        if (focus === "servers" && server && sitesForServer(server.id).length > 0) {
          beginClone(server)
        }
        return
      case "V":
        // Create the vanity site at the server's own hostname. Offered whenever
        // the server doesn't already HAVE a site there — a busy server benefits
        // just as much as an empty one (the hostname page + a key-holding site
        // user). Also reopens an unfinished build for this server (in-flight,
        // parked at the SSH-key step, or errored — all after the site may exist).
        if (server) {
          const resumable = vanityJob && vanityJob.step !== "done" && vanityJob.serverId === server.id
          const hasVanity = sitesForServer(server.id).some((s) => s.domain.toLowerCase() === server.name.toLowerCase())
          if (resumable || !hasVanity) setVanityServer(server)
        }
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

  const listRows = Math.max(3, rows - 6 - SITE_CONTEXT_STRIP_HEIGHT)
  const focusedSite = sites[Math.min(siteIndex, Math.max(0, sites.length - 1))]

  const hints =
    focus === "servers"
      ? [
          { key: "↑↓/jk", label: "select" },
          { key: "→/⏎", label: "view sites" },
          { key: "c", label: "new server" },
          { key: "S", label: "connect sudo" },
          { key: "a", label: "server actions" },
          { key: "N", label: "DNS hosts" },
          { key: "h", label: "health" },
          { key: "w", label: "SpinupWP" },
        ]
      : [
          { key: "↑↓/jk", label: "select site" },
          { key: "←/esc", label: "back" },
          { key: "d", label: "identify app" },
          { key: "n", label: "DNS host" },
          { key: "u", label: "change PHP" },
          { key: "m", label: "monitoring" },
          { key: "K", label: "grant key" },
          { key: "o", label: "open" },
          { key: "w", label: "SpinupWP" },
          { key: "s", label: "ssh" },
          { key: "h", label: "health" },
        ]

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row", padding: 1, gap: 1 }}>
        {/* Servers pane */}
        <Panel title={` Servers (${sortedServers.length}) `} active={focus === "servers"} width={44}>
          <List
            items={sortedServers}
            selectedIndex={serverIndex}
            viewportRows={listRows}
            focused={focus === "servers"}
            keyFor={(s) => s.id}
            emptyText="No servers yet — press c to create one"
            renderRow={(s, selected) => {
              const count = sitesForServer(s.id).length
              const op = serverOps.get(s.id)
              return (
                <>
                  <text content={statusDot(s.connection_status) + " "} fg={statusColor(s.connection_status)} style={{ flexShrink: 0 }} />
                  <text content={truncate(s.name, 30)} fg={selected ? theme.text : count === 0 ? theme.warn : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  {op && isServerOpInFlight(op) ? (
                    <box style={{ flexDirection: "row", flexShrink: 0 }}>
                      <text content=" " style={{ flexShrink: 0 }} />
                      <Spinner color={selected ? theme.text : theme.brand} interval={120} />
                      <text content={op.label} fg={selected ? theme.text : theme.warn} wrapMode="none" />
                    </box>
                  ) : op?.status === "failed" ? (
                    <text content=" op!" fg={selected ? theme.text : theme.bad} style={{ flexShrink: 0 }} />
                  ) : (
                    s.reboot_required && <text content=" ↻ rbt" fg={selected ? theme.text : theme.warn} style={{ flexShrink: 0 }} />
                  )}
                  {s.upgrade_required && <text content=" ⬆ upg" fg={selected ? theme.text : theme.warn} style={{ flexShrink: 0 }} />}
                  {isServerOsEol(s) && <text content=" ⚠ os" fg={selected ? theme.text : theme.bad} style={{ flexShrink: 0 }} />}
                  {isSudoConnected(s.id) && <text content=" ● sudo" fg={selected ? theme.text : theme.good} style={{ flexShrink: 0 }} />}
                  {/* A server with no sites is a dead end (can't connect/SSH until it
                      has a site) — flag the 0 in amber so it's easy to spot. */}
                  <text content={" " + count} fg={selected ? theme.text : count === 0 ? theme.warn : theme.textFaint} style={{ flexShrink: 0 }} />
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
            emptyText="No sites yet — press V to create a vanity site and connect this server"
            renderRow={(s, selected) => {
              const updates = (s.wp_plugin_updates || 0) + (s.wp_theme_updates || 0) + (s.wp_core_update ? 1 : 0)
              const stack = classifyStack(s)
              const keyKinds = grantedKeyKinds(s.id)
              return (
                <>
                  <text content={statusDot(s.status) + " "} fg={statusColor(s.status)} style={{ flexShrink: 0 }} />
                  <text content={truncate(s.domain, 40)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  <SiteMetaCell linked={localLinks.has(s.id)} updates={updates} personalKey={keyKinds.personal > 0} machineKey={keyKinds.machine > 0} selected={selected} />
                  <text content={stackTag(stack) + " "} fg={stackColor(stack, selected)} style={{ flexShrink: 0 }} />
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
            <ServerDetail server={server} siteCount={sites.length} showControl />
          ) : (
            <text content="No data" fg={theme.textFaint} />
          )}
        </Panel>
      </box>
      <SiteContextStrip site={focus === "sites" ? focusedSite ?? null : null} />
      <StatusBar hints={hints} message={flash ?? undefined} messageColor={theme.brand} />
    </box>
  )
}

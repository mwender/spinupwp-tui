// Take one site offline, or bring it back — opened with `O` on a selected site
// (Servers tab, Search, Stacks). The server-wide version is the last row of the
// server actions menu (`a`); both share lib/offline.ts and ../offlineRun.tsx,
// and a site taken offline here is recorded under its server, so bringing the
// server back covers it too.
//
// The confirm screen is honest about the limit: PHP is shared by the whole
// server, so while any other site on it is up, PHP is still reachable.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { loadConfig } from "../../config.ts"
import { isDevMode } from "../../dev/devMode.ts"
import { loadOfflineState, takeSiteOffline, bringServerOnline } from "../../lib/offline.ts"
import { offlineDir, useOfflineRun, OfflineProgress } from "../offlineRun.tsx"

type Phase = "confirm" | "running"

export function SiteOffline() {
  const store = useStore()
  const { siteOfflineSite, setSiteOfflineSite, sites, servers, sitesForServer, refresh, kumaConfigured } = store
  // The overlay was opened with a snapshot; read the live row so a refresh
  // after the run shows the new state.
  const site = sites.find((s) => s.id === siteOfflineSite?.id) ?? siteOfflineSite
  const server = site ? servers.find((s) => s.id === site.server_id) : undefined

  const [phase, setPhase] = useState<Phase>("confirm")
  const { run, start } = useOfflineRun(refresh)

  const recorded = !!(site && loadOfflineState(offlineDir()).servers[String(site.server_id)]?.sites.some((s) => s.id === site.id))
  // What `y` would do. A site disabled some other way isn't ours to re-enable.
  const mode: "offline" | "online" | "foreign" = !site?.disabled_at ? "offline" : recorded ? "online" : "foreign"
  const neighbours = site && server ? sitesForServer(server.id).filter((s) => s.id !== site.id && !s.disabled_at) : []

  const close = () => setSiteOfflineSite(null)

  const go = () => {
    if (!site || !server || mode === "foreign") return
    setPhase("running")
    const cfg = loadConfig()
    start(mode, site.domain, async (onProgress) => {
      const o = { onProgress, kuma: !isDevMode(), dir: offlineDir() }
      if (mode === "offline") {
        const r = await takeSiteOffline(store.client, cfg, server, site.id, o)
        const failed = r.failed.length > 0
        return { failed, summary: failed ? r.failed[0]!.error : `offline${r.kuma === "shielded" ? " · Kuma monitors in maintenance" : ""}` }
      }
      const r = await bringServerOnline(store.client, cfg, server.id, { ...o, siteIds: [site.id] })
      const failed = r.failed.length > 0
      return { failed, summary: failed ? `${r.failed[0]!.error} Press O to retry.` : "back online" }
    })
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()
    if (phase === "confirm" && name === "y") go()
  })

  if (!site) return null

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.bg,
        zIndex: 210,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          height: 1,
          backgroundColor: theme.bgAlt,
          paddingLeft: 1,
          paddingRight: 1,
          alignItems: "center",
        }}
      >
        <text content="⏻ Site offline  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        {server && <text content={truncate(server.name, 30)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />}
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar
        hints={phase === "confirm" && mode !== "foreign" ? [{ key: "y", label: "confirm" }, { key: "esc", label: "cancel" }] : [{ key: "esc", label: "close" }]}
        showGlobal={false}
      />
    </box>
  )

  function renderBody() {
    if (phase === "running" && run) return <OfflineProgress run={run} plural={false} />

    if (mode === "foreign") {
      return (
        <Panel title=" Already offline " active>
          <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`${site!.domain} is disabled, but not by SpinupTUI, so it's left alone.`} fg={theme.text} />
            <box style={{ height: 1 }} />
            <text content="Re-enable it in SpinupWP if that's what you want (w opens the site there from the list)." fg={theme.textDim} />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (mode === "online") {
      return (
        <Panel title=" Confirm " active>
          <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Bring " fg={theme.text} wrapMode="none" />
              <text content={truncate(site!.domain, 36)} fg={theme.accent} wrapMode="none" />
              <text content=" back online?" fg={theme.text} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="It serves traffic again exactly as before. Other sites on the server stay as they are." fg={theme.textDim} />
            <box style={{ height: 1 }} />
            <text content="Press y to confirm · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    const n = neighbours.length
    return (
      <Panel title=" Confirm " active>
        <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="Take " fg={theme.text} wrapMode="none" />
            <text content={truncate(site!.domain, 40)} fg={theme.accent} wrapMode="none" />
            <text content=" offline?" fg={theme.text} wrapMode="none" />
          </box>
          <box style={{ height: 1 }} />
          <text content="nginx stops answering for its domains: visitors can't connect and no request reaches PHP through this site." fg={theme.warn} />
          <text content="Files, database and certificate are untouched; O again brings it back." fg={theme.textDim} />
          <box style={{ height: 1 }} />
          {n > 0 ? (
            <>
              <text
                content={`${n} other site${n === 1 ? "" : "s"} on ${server?.name ?? "this server"} stay${n === 1 ? "s" : ""} up, so the server's PHP is still reachable through ${n === 1 ? "it" : "them"}.`}
                fg={theme.textDim}
              />
              <text content="To protect the whole server, use a on the server instead." fg={theme.textDim} />
            </>
          ) : (
            <text content="It's the only site still up on this server." fg={theme.textDim} />
          )}
          {kumaConfigured && <text content="Its Uptime Kuma monitors enter a maintenance window — no false alerts." fg={theme.textFaint} />}
          <box style={{ height: 1 }} />
          <text content="Press y to confirm · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }
}

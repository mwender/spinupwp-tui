// Finalize an already-moved server: final DB sync, verify destination, report
// stale DBs, then hand off to provider-neutral cutover.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, type FinalizeMoveSiteState } from "../store.tsx"

const RAIL_W = 24
const SITES_PER_PAGE = 25
const STEPS = [
  { step: "plan", label: "Destination" },
  { step: "connect", label: "Connect" },
  { step: "sync", label: "DB sync" },
  { step: "cutover", label: "Cutover" },
]

export function FinalizeMove() {
  const {
    finalizeMoveServer: server,
    finalizeMoveJob: job,
    servers,
    sitesForServer,
    finalizeMoveSetDest,
    toggleFinalizeMoveSite,
    toggleFinalizeMoveAll,
    finalizeMoveGoBack,
    startFinalizeMoveSync,
    finalizeRetryTls,
    finalizeMoveFinishCutover,
    clearFinalizeMove,
    isSudoConnected,
    setSudoConnectServer,
    sudoConnectServer,
  } = useStore()

  const [idx, setIdx] = useState(0)
  const [destIdx, setDestIdx] = useState(0)

  const eligibleDests = useMemo(
    () => (job ? servers.filter((s) => s.id !== job.sourceServerId).slice().sort((a, b) => a.name.localeCompare(b.name)) : []),
    [servers, job],
  )
  const selected = job?.sites.filter((s) => s.selected && s.ready) ?? []
  const curStepIdx = job?.step === "done" ? STEPS.length : Math.max(0, STEPS.findIndex((s) => s.step === job?.step))
  const sitePageCount = Math.max(1, Math.ceil((job?.sites.length ?? 0) / SITES_PER_PAGE))
  const sitePage = Math.min(sitePageCount - 1, Math.floor(idx / SITES_PER_PAGE))
  const sitePageStart = sitePage * SITES_PER_PAGE

  useEffect(() => setIdx(0), [job?.step])
  useEffect(() => {
    if (job?.step === "sync" && !job.fanoutStarted) startFinalizeMoveSync()
  }, [job?.step, job?.fanoutStarted, startFinalizeMoveSync])

  useKeyboard((key) => {
    if (!job || !server || sudoConnectServer) return
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw
    if (name === "escape" || name === "q") return clearFinalizeMove()
    if (name === "left" || name === "h") return finalizeMoveGoBack()

    if (job.step === "plan") {
      const n = eligibleDests.length
      if (n > 0 && (name === "up" || name === "k")) return setDestIdx((i) => (i - 1 + n) % n)
      if (n > 0 && (name === "down" || name === "j")) return setDestIdx((i) => (i + 1) % n)
      if (name === "return") {
        const chosen = eligibleDests[destIdx]
        if (chosen) finalizeMoveSetDest(chosen)
      }
      return
    }

    if (job.step === "connect") {
      const dest = job.destServerId != null ? servers.find((s) => s.id === job.destServerId) : undefined
      if (name === "S" && !isSudoConnected(server.id)) return setSudoConnectServer(server)
      if (name === "D" && dest && !isSudoConnected(dest.id)) return setSudoConnectServer(dest)
      const n = job.sites.length
      if (n > 0 && (name === "up" || name === "k")) return setIdx((i) => (i - 1 + n) % n)
      if (n > 0 && (name === "down" || name === "j")) return setIdx((i) => (i + 1) % n)
      if (n > SITES_PER_PAGE && (name === "pageup" || name === "[")) return moveSitePage(-1)
      if (n > SITES_PER_PAGE && (name === "pagedown" || name === "]")) return moveSitePage(1)
      const cur = job.sites[idx]
      if (name === "space" && cur) return toggleFinalizeMoveSite(cur.sourceSiteId)
      if (name === "a") return toggleFinalizeMoveAll()
      if (name === "return" && dest && isSudoConnected(server.id) && isSudoConnected(dest.id) && selected.length > 0) return startFinalizeMoveSync()
      return
    }

    if (job.step === "sync" || job.step === "error" || job.step === "done") {
      const n = job.sites.length
      if (n > 0 && (name === "up" || name === "k")) return setIdx((i) => (i - 1 + n) % n)
      if (n > 0 && (name === "down" || name === "j")) return setIdx((i) => (i + 1) % n)
      if (n > SITES_PER_PAGE && (name === "pageup" || name === "[")) return moveSitePage(-1)
      if (n > SITES_PER_PAGE && (name === "pagedown" || name === "]")) return moveSitePage(1)
      const cur = job.sites[idx]
      if (name === "T" && cur?.sourceHttps && cur.destSiteId) return finalizeRetryTls(cur.sourceSiteId)
      return
    }

    if (job.step === "cutover") {
      if (name === "T") {
        for (const s of job.sites) if (s.selected && s.sourceHttps && s.destSiteId) finalizeRetryTls(s.sourceSiteId)
        return
      }
      if (name === "return" || name === "f") return finalizeMoveFinishCutover()
    }
  })

  if (!server || !job) return null

  function moveSitePage(delta: number) {
    setIdx((current) => {
      const count = job!.sites.length
      const pages = Math.ceil(count / SITES_PER_PAGE)
      const slot = current % SITES_PER_PAGE
      const targetPage = (Math.floor(current / SITES_PER_PAGE) + delta + pages) % pages
      return Math.min(targetPage * SITES_PER_PAGE + slot, count - 1)
    })
  }

  function sitePageRows(selectable: boolean) {
    return job!.sites.slice(sitePageStart, sitePageStart + SITES_PER_PAGE).map((s, offset) => siteRow(s, sitePageStart + offset === idx, selectable))
  }

  function pageLabel() {
    return job!.sites.length > SITES_PER_PAGE ? `Page ${sitePage + 1}/${sitePageCount} · ${sitePageStart + 1}–${Math.min(sitePageStart + SITES_PER_PAGE, job!.sites.length)} of ${job!.sites.length}` : null
  }

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 219 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="Finalize move  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={`${server.name} -> ${job.destServerName || "destination"} (${selected.length} selected)`} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        {railPane()}
        <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>{rightPane()}</box>
      </box>
      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function railPane() {
    return (
      <box style={{ width: RAIL_W, flexShrink: 0, flexDirection: "column", borderStyle: "single", borderColor: theme.border, paddingLeft: 1, paddingRight: 1 }}>
        <text content="FINALIZE" fg={theme.textFaint} wrapMode="none" />
        <box style={{ height: 1 }} />
        {STEPS.map((s, i) => {
          const state = i < curStepIdx ? "done" : i === curStepIdx ? "active" : "pending"
          const glyph = state === "done" ? "✓" : state === "active" ? "❯" : "○"
          const color = state === "done" ? theme.good : state === "active" ? theme.brand : theme.textFaint
          return (
            <box key={s.step} style={{ flexDirection: "row", height: 1 }}>
              <text content={`${glyph} `} fg={color} style={{ flexShrink: 0 }} />
              <text content={s.label} fg={state === "pending" ? theme.textFaint : theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
            </box>
          )
        })}
        <box style={{ flexGrow: 1 }} />
        <text content={"─".repeat(RAIL_W - 2)} fg={theme.border} wrapMode="none" />
        <text content={`src ${truncate(server!.name, RAIL_W - 6)}`} fg={theme.textDim} wrapMode="none" />
        <text content={`dst ${truncate(job!.destServerName || "—", RAIL_W - 6)}`} fg={theme.textDim} wrapMode="none" />
      </box>
    )
  }

  function rightPane() {
    if (job!.step === "plan") return destinationPane()
    if (job!.step === "connect") return connectPane()
    if (job!.step === "sync" || job!.step === "error" || job!.step === "done") return syncPane()
    return cutoverPane()
  }

  function destinationPane() {
    return (
      <Panel title=" Destination — choose the already-migrated server " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content="Pick the server that already has matching destination sites." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          {eligibleDests.map((s, i) => {
            const focused = i === destIdx
            const count = sitesForServer(s.id).length
            return (
              <box key={s.id} style={{ flexDirection: "row", height: 1, backgroundColor: focused ? theme.bgAlt : undefined }}>
                <text content={focused ? "❯ " : "  "} fg={theme.brand} style={{ flexShrink: 0 }} />
                <text content={s.name} fg={focused ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
                <box style={{ flexGrow: 1 }} />
                <text content={`${count} site${count === 1 ? "" : "s"} · ${s.provider_name || "—"} · ${s.ip_address || "no IP"}`} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
              </box>
            )
          })}
        </box>
      </Panel>
    )
  }

  function connectPane() {
    const dest = job!.destServerId != null ? servers.find((s) => s.id === job!.destServerId) : undefined
    const srcOn = isSudoConnected(server!.id)
    const destOn = !!dest && isSudoConnected(dest.id)
    return (
      <Panel title=" Connect — confirm sites and sudo access " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content={`${srcOn ? "✓" : "○"} source sudo ${srcOn ? "connected" : "not connected — press S"}`} fg={srcOn ? theme.good : theme.warn} wrapMode="none" />
          <text content={`${destOn ? "✓" : "○"} destination sudo ${destOn ? "connected" : "not connected — press D"}`} fg={destOn ? theme.good : theme.warn} wrapMode="none" />
          <box style={{ height: 1 }} />
          {sitePageRows(true)}
          {pageLabel() ? <text content={pageLabel()!} fg={theme.textFaint} wrapMode="none" /> : null}
          <box style={{ flexGrow: 1 }} />
          {srcOn && destOn && selected.length > 0 ? (
            <text content="❯ Enter — activate source maintenance and run final DB sync" fg={theme.brand} wrapMode="none" />
          ) : (
            <text content="Connect both servers and select at least one matched WordPress site." fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  function syncPane() {
    const failed = job!.sites.filter((s) => s.step === "error")
    return (
      <Panel title={job!.step === "error" ? " DB sync failed " : job!.step === "done" ? " Finalized " : " DB sync "} active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          {sitePageRows(false)}
          {pageLabel() ? <text content={pageLabel()!} fg={theme.textFaint} wrapMode="none" /> : null}
          {failed.length > 0 ? (
            <>
              <box style={{ height: 1 }} />
              <text content={job!.error ?? "One or more sites failed."} fg={theme.bad} wrapMode="none" />
              {job!.logPath ? <text content={`Full stage output: ${job!.logPath}`} fg={theme.textFaint} wrapMode="none" /> : null}
            </>
          ) : null}
          {job!.backupSnapshotPath ? <text content={`Backup snapshot: ${job!.backupSnapshotPath}`} fg={theme.textFaint} wrapMode="none" /> : null}
          <box style={{ flexGrow: 1 }} />
          {job!.sites.some((s) => s.sourceHttps && s.destSiteId) ? <text content="T stage/retry HTTPS on the highlighted site" fg={theme.warn} wrapMode="none" /> : null}
          {job!.step === "done" ? <text content="The workflow is complete." fg={theme.good} wrapMode="none" /> : null}
        </box>
      </Panel>
    )
  }

  function cutoverPane() {
    const inv = job!.inventory
    return (
      <Panel title=" Cutover — provider-neutral handoff " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content="DB sync and PHP-FPM parity passed. Source sites are still in maintenance mode." fg={theme.text} wrapMode="none" />
          <text content="Point traffic at the destination using DNS, IP reassignment, or your provider console." fg={theme.textFaint} wrapMode="none" />
          {job!.logPath ? <text content={`Log: ${job!.logPath}`} fg={theme.textFaint} wrapMode="none" /> : null}
          {job!.backupSnapshotPath ? <text content={`Backup snapshot: ${job!.backupSnapshotPath}`} fg={theme.textFaint} wrapMode="none" /> : null}
          <box style={{ height: 1 }} />
          <text content={`Destination IP: ${job!.destServerIp || "unknown"}`} fg={theme.textDim} wrapMode="none" />
          <text content={`Domains: ${selected.map((s) => s.domain).join(", ")}`} fg={theme.textDim} wrapMode="none" />
          {selected.some((s) => s.sourceHttps) ? <text content="T — stage/retry HTTPS certificates before traffic moves" fg={theme.warn} wrapMode="none" /> : null}
          <box style={{ height: 1 }} />
          <text content="Destination DB inventory" fg={theme.text} wrapMode="none" />
          {!inv ? <text content="Reading databases…" fg={theme.textFaint} wrapMode="none" /> : inv.error ? <text content={inv.error} fg={theme.bad} wrapMode="none" /> : null}
          {inv ? <text content={`Active: ${inv.active.length ? inv.active.join(", ") : "none discovered"}`} fg={theme.good} wrapMode="none" /> : null}
          {inv ? <text content={`Possible stale DBs: ${inv.stale.length ? inv.stale.join(", ") : "none"}`} fg={inv.stale.length ? theme.warn : theme.textFaint} wrapMode="none" /> : null}
          <box style={{ flexGrow: 1 }} />
          <text content="❯ Enter — mark cutover done after you verify public traffic" fg={theme.brand} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function siteRow(s: FinalizeMoveSiteState, focused: boolean, selectable: boolean) {
    const glyph = s.step === "done" ? "✓" : s.step === "error" ? "✕" : s.step === "syncing" ? "⠹" : s.selected ? "●" : "○"
    const color = s.step === "done" ? theme.good : s.step === "error" ? theme.bad : s.step === "syncing" ? theme.brand : s.ready ? theme.text : theme.textFaint
    const tls = s.tls?.status === "handing-off" ? " · TLS…" : s.tls?.status === "handed-off" ? " · TLS staged" : s.tls?.status === "error" ? " · TLS retry" : ""
    const meta = (!s.isWordPress ? "not WordPress" : !s.ready ? s.error ?? "not matched" : s.step === "syncing" ? s.detail ?? "syncing" : s.destDbName ? `DB ${s.destDbName}` : s.selected ? "selected" : "skipped") + tls
    return (
      <box key={s.sourceSiteId} style={{ flexDirection: "row", height: 1, backgroundColor: focused ? theme.bgAlt : undefined }}>
        <text content={`${glyph} `} fg={color} style={{ flexShrink: 0 }} />
        <text content={truncate(s.domain, 44)} fg={color} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        {s.step === "syncing" ? <Spinner /> : null}
        <text content={selectable && s.ready ? `${meta} · space toggles` : meta} fg={s.step === "error" ? theme.bad : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      </box>
    )
  }

  function hints() {
    if (job!.step === "plan") return [{ key: "↑↓", label: "select dest" }, { key: "⏎", label: "use server" }, { key: "esc", label: "close" }]
    if (job!.step === "connect") return [{ key: "S/D", label: "connect sudo" }, { key: "space", label: "toggle site" }, { key: "a", label: "toggle all" }, { key: "Pg↑↓/[ ]", label: "page" }, { key: "⏎", label: "sync DBs" }, { key: "esc", label: "close" }]
    if (job!.step === "cutover") return [{ key: "T", label: "stage HTTPS" }, { key: "⏎", label: "finish" }, { key: "esc", label: "close" }]
    return [{ key: "↑↓", label: "select" }, { key: "T", label: "stage HTTPS" }, { key: "Pg↑↓/[ ]", label: "page" }, { key: "esc", label: "close" }]
  }
}

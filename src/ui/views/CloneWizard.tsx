// "Clone a server to a new server" wizard (backlog item 5). A two-pane overlay: a
// fixed left Journey Rail (the five server-level steps + a src→dst footer) and a
// right pane that changes per step. The two heavy steps (Clone sites, DNS cutover)
// expand into a per-site roster. Driven by the store's CloneJob whose fan-out lives
// in `sites[]`. See docs/2026-06-24_clone-to-server-spec.md.
//
// SLICE 2 (this file): the shell + the Plan step (site-select + pre-flight + the two
// "all sites" toggles). The New-server / Connect-dest / Clone / Cutover steps render
// as scaffolding (rail advances, rosters preview) — their orchestration lands in
// later slices.

import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { Panel, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { openUrl } from "../../lib/open.ts"
import { serverWebUrl } from "../../lib/spinupweb.ts"
import { useStore, type CloneStep, type CloneSiteStep } from "../store.tsx"

// Dev-only: skip provisioning and use an existing server as the clone dest (e.g. a
// pre-made web2). Set SPINUP_DEV_CLONE_DEST=<serverId> in .env. The real flow never
// depends on this — it's purely a dev shortcut so the downstream slices are testable
// without a ~10-min provision each run.
const DEV_CLONE_DEST = Number(process.env.SPINUP_DEV_CLONE_DEST) || null
// Dev-only: auto-connect sudo on both ends from .env (SPINUP_DEV_SUDO_SOURCE/DEST,
// each "user:password"), so the full clone is testable headlessly without typing
// passwords into SudoConnect. The real flow never reads these.
const DEV_SUDO = { source: process.env.SPINUP_DEV_SUDO_SOURCE || "", dest: process.env.SPINUP_DEV_SUDO_DEST || "" }

const STEPS: { step: CloneStep; label: string }[] = [
  { step: "plan", label: "Plan" },
  { step: "server", label: "New server" },
  { step: "trust", label: "Connect dest" },
  { step: "clone", label: "Clone sites" },
  { step: "cutover", label: "DNS cutover" },
]
const RAIL_W = 24

export function CloneWizard() {
  const {
    cloneServer: server,
    cloneJob: job,
    servers,
    accountSlug,
    toggleCloneSite,
    toggleCloneSiteUploads,
    cloneAdvanceFromPlan,
    cloneSetDest,
    cloneTrustContinue,
    cloneSizeSites,
    startClone,
    cloneRetrySite,
    toggleCloneLowerTtl,
    clearClone,
    isSudoConnected,
    setSudoConnectServer,
    connectSudo,
    newServerOpen,
    newServerJob,
    setNewServerOpen,
    setNewServerSource,
    clearNewServer,
    sudoConnectServer,
  } = useStore()

  const [idx, setIdx] = useState(0)
  const [sizeTried, setSizeTried] = useState(false)
  const [cloneStarted, setCloneStarted] = useState(false)

  // Kick the fan-out once, when we land on the Clone step.
  useEffect(() => {
    if (job?.step === "clone" && !cloneStarted) {
      setCloneStarted(true)
      startClone()
    }
  }, [job?.step, cloneStarted, startClone])

  // Dev-only auto-sudo (both ends) from .env so the flow is testable headlessly.
  const devSudoTried = useRef(new Set<number>())
  useEffect(() => {
    if (!server || !job) return
    const tryConn = (srv: typeof server | undefined, cred: string) => {
      if (!srv || !cred || isSudoConnected(srv.id) || devSudoTried.current.has(srv.id)) return
      const [u, ...r] = cred.split(":")
      if (!u) return
      devSudoTried.current.add(srv.id)
      void connectSudo(srv, u, r.join(":"))
    }
    tryConn(servers.find((s) => s.id === job.sourceServerId), DEV_SUDO.source)
    const destId = job.destServerId ?? DEV_CLONE_DEST
    tryConn(destId != null ? servers.find((s) => s.id === destId) : undefined, DEV_SUDO.dest)
  }, [server, job, servers, isSudoConnected, connectSudo])

  const devDest = DEV_CLONE_DEST != null ? servers.find((s) => s.id === DEV_CLONE_DEST) ?? null : null

  // Measure source site sizes once, the moment source sudo is connected (Plan total
  // + per-site GB). Runs a single du+wp-db-size pass over the sudo connection.
  useEffect(() => {
    if (!server || sizeTried) return
    if (job?.step === "plan" && isSudoConnected(server.id) && job.sites.length > 0) {
      setSizeTried(true)
      void cloneSizeSites()
    }
  }, [server, job, sizeTried, isSudoConnected, cloneSizeSites])

  // Bridge: when the reused NewServer flow finishes provisioning, capture the new
  // box as the clone dest and close it. (Standalone NewServer use sets no cloneJob,
  // so this only fires inside the wizard's "server" step.)
  useEffect(() => {
    if (job?.step !== "server" || job.destServerId != null) return
    if (newServerJob?.status === "done" && newServerJob.serverId != null) {
      const created = servers.find((s) => s.id === newServerJob.serverId)
      if (created) {
        cloneSetDest(created)
        clearNewServer()
        setNewServerOpen(false)
      }
    }
  }, [job, newServerJob, servers, cloneSetDest, clearNewServer, setNewServerOpen])

  const close = () => clearClone()

  useKeyboard((key) => {
    if (!job || !server) return
    // A layered overlay (NewServer / SudoConnect) owns the keyboard while open.
    if (newServerOpen || sudoConnectServer) return
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw

    if (name === "escape" || name === "q") return close()

    if (job.step === "plan") {
      // S — connect sudo on the SOURCE (pre-flight; the pull needs it later).
      if (name === "S" && !isSudoConnected(server.id)) return setSudoConnectServer(server)
      const n = job.sites.length
      if (name === "up" || name === "k") return setIdx((i) => (i - 1 + n) % n)
      if (name === "down" || name === "j") return setIdx((i) => (i + 1) % n)
      const cur = job.sites[idx]
      if (name === "space" && cur) return toggleCloneSite(cur.sourceSiteId)
      if (name === "u" && cur) return toggleCloneSiteUploads(cur.sourceSiteId)
      if (name === "t") return toggleCloneLowerTtl()
      if (name === "return") return cloneAdvanceFromPlan()
    }

    if (job.step === "server") {
      if (devDest && name === "d") return cloneSetDest(devDest)
      if (name === "return") {
        // Reuse the standalone New-server flow, seeded from the source.
        setNewServerSource(server)
        setNewServerOpen(true)
      }
    }

    if (job.step === "trust") {
      const destServer = job.destServerId != null ? servers.find((s) => s.id === job.destServerId) ?? null : null
      // S — connect sudo on the DEST; G — re-check/connect sudo on the SOURCE.
      if (name === "S" && destServer && !isSudoConnected(destServer.id)) return setSudoConnectServer(destServer)
      if (name === "G" && !isSudoConnected(server.id)) return setSudoConnectServer(server)
      if (name === "w" && destServer && accountSlug) return openUrl(serverWebUrl(destServer.id, accountSlug))
      if (name === "return") {
        const bothConnected = isSudoConnected(server.id) && destServer != null && isSudoConnected(destServer.id)
        if (bothConnected) return cloneTrustContinue()
      }
    }

    if (job.step === "clone" || job.step === "done") {
      // r — retry every failed site.
      if (name === "r") {
        for (const s of job.sites) if (s.selected && s.step === "error") cloneRetrySite(s.sourceSiteId)
        return
      }
    }
  })

  if (!server || !job) return null

  const selected = job.sites.filter((s) => s.selected)
  const sudoOn = isSudoConnected(server.id)
  const curStepIdx = job.step === "done" ? STEPS.length : STEPS.findIndex((s) => s.step === job.step)

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 218 }}>
      {/* header */}
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="✦ Clone server  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={`${server.name} (${selected.length} of ${job.sites.length} sites) → new server`} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      {/* two panes */}
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
        <text content="JOURNEY" fg={theme.textFaint} wrapMode="none" />
        <box style={{ height: 1 }} />
        {STEPS.map((s, i) => {
          const state = i < curStepIdx ? "done" : i === curStepIdx ? "active" : "pending"
          const glyph = state === "done" ? "✓" : state === "active" ? "❯" : "○"
          const color = state === "done" ? theme.good : state === "active" ? theme.brand : theme.textFaint
          // N-fraction badge on the two roster steps.
          const badge = s.step === "clone" || s.step === "cutover" ? ` ${countDone(s.step)}/${selected.length}` : ""
          return (
            <box key={s.step} style={{ flexDirection: "row", height: 1 }}>
              <text content={`${glyph} `} fg={color} style={{ flexShrink: 0 }} />
              <text content={s.label} fg={state === "pending" ? theme.textFaint : theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
              {badge ? <text content={badge} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
            </box>
          )
        })}
        <box style={{ flexGrow: 1 }} />
        <text content={"─".repeat(RAIL_W - 2)} fg={theme.border} wrapMode="none" />
        <box style={{ flexDirection: "row", height: 1 }}>
          <text content="src " fg={theme.textFaint} style={{ flexShrink: 0 }} />
          <text content={truncate(server!.name, RAIL_W - 6)} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
        </box>
        <box style={{ flexDirection: "row", height: 1 }}>
          <text content="dst " fg={theme.textFaint} style={{ flexShrink: 0 }} />
          <text content={job!.destServerName || job!.destServerIp || "—"} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
        </box>
      </box>
    )
  }

  function rightPane() {
    if (job!.step === "plan") return planPane()
    if (job!.step === "server") return serverPane()
    if (job!.step === "trust") return trustPane()
    if (job!.step === "clone" || job!.step === "done") return clonePane()
    if (job!.step === "cutover") return cutoverPane()
    // error — scaffolding for now.
    return (
      <Panel title={` ${STEPS[curStepIdx]?.label ?? job!.step} `} active>
        <box style={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }}>
          <text content="This step is built in a later slice of the wizard." fg={theme.textDim} wrapMode="none" />
          <text content="The Plan is captured; the rail shows where we are." fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function serverPane() {
    const sp = job!.specs
    return (
      <Panel title=" New server — provision the destination " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content="Stand up a fresh server to receive the cloned sites." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Match source:" fg={theme.textFaint} wrapMode="none" />
          <text content={`  ${sp.providerName || "—"} · ${sp.region || "—"} · ${sp.size || "—"}`} fg={theme.text} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="❯ Enter — open the new-server form (provider/region/size/cost)" fg={theme.brand} wrapMode="none" />
          {devDest ? (
            <>
              <box style={{ height: 1 }} />
              <text content={`d — DEV: use existing dest ${devDest.name} (skip provisioning)`} fg={theme.warn} wrapMode="none" />
            </>
          ) : null}
          <box style={{ flexGrow: 1 }} />
          <text content="Provisioning runs in the background and the wizard waits for it." fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function trustPane() {
    const destServer = job!.destServerId != null ? servers.find((s) => s.id === job!.destServerId) ?? null : null
    const srcOn = isSudoConnected(server!.id)
    const destOn = destServer != null && isSudoConnected(destServer.id)
    const both = srcOn && destOn
    const row = (ok: boolean, label: string) => (
      <box style={{ flexDirection: "row", height: 1 }}>
        <text content={ok ? "✓ " : "○ "} fg={ok ? theme.good : theme.warn} style={{ flexShrink: 0 }} />
        <text content={label} fg={ok ? theme.textDim : theme.warn} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
    )
    return (
      <Panel title=" Connect dest — the privileged foothold " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content={`Dest: ${job!.destServerName || "—"}  ${job!.destServerIp || ""}`} fg={theme.text} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Spinup needs a sudo connection on BOTH ends: root on the source" fg={theme.textFaint} wrapMode="none" />
          <text content="to read each site, root on the dest to write + import." fg={theme.textFaint} wrapMode="none" />
          <box style={{ height: 1 }} />
          {row(srcOn, srcOn ? "Source sudo connected" : "Source sudo not connected — press G")}
          {row(destOn, destOn ? "Dest sudo connected" : "Dest sudo not connected — create a sudo user (w), then press S")}
          <box style={{ flexGrow: 1 }} />
          {both ? (
            <text content="❯ Enter — both ends connected, continue to clone" fg={theme.brand} wrapMode="none" />
          ) : (
            <text content="Connect sudo on both ends to continue." fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  function planPane() {
    return (
      <Panel title=" Plan — choose sites to clone " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="Bring which sites?" fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
            <box style={{ flexGrow: 1 }} />
            <text content={`${selected.length} of ${job!.sites.length} selected`} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
          </box>
          <box style={{ height: 1 }} />
          {job!.sites.map((s, i) => {
            const sel = i === idx
            const mark = s.selected ? "◉" : "◯"
            const markColor = s.selected ? theme.good : theme.textFaint
            const size = s.sizeBytes != null ? formatBytes(s.sizeBytes) : "—"
            const tag = s.stack === "bedrock" ? "bedrock" : ""
            const note = !s.selected ? " (skipped)" : s.excludeUploads ? " (no uploads)" : ""
            return (
              <box key={s.sourceSiteId} style={{ flexDirection: "row", height: 1, backgroundColor: sel ? theme.bgAlt : undefined }}>
                <text content={` ${mark} `} fg={markColor} style={{ flexShrink: 0 }} />
                <text content={s.domain} fg={sel ? theme.text : s.selected ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
                <box style={{ flexGrow: 1 }} />
                {tag ? <text content={`${tag}  `} fg={sel ? theme.text : theme.accent} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
                <text content={size} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
                {note ? <text content={note} fg={sel ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
              </box>
            )
          })}
          <box style={{ flexGrow: 1 }} />
          <text content={payloadLine()} fg={theme.textFaint} wrapMode="none" />
          <box style={{ height: 1 }} />
          {/* pre-flight */}
          <box style={{ flexDirection: "row", height: 1 }}>
            <text content={sudoOn ? "✓ " : "○ "} fg={sudoOn ? theme.good : theme.warn} style={{ flexShrink: 0 }} />
            <text content={sudoOn ? "Sudo connected on the source" : "Sudo not connected on the source — press S"} fg={sudoOn ? theme.textDim : theme.warn} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
          <box style={{ flexDirection: "row", height: 1 }}>
            <text content={job!.lowerTtlEarly ? "◉ " : "◯ "} fg={job!.lowerTtlEarly ? theme.good : theme.textFaint} style={{ flexShrink: 0 }} />
            <text content="Lower DNS TTL now (t) — makes cutover near-instant later" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
        </box>
      </Panel>
    )
  }

  // DNS cutover roster — still scaffolding (slice 6).
  function cutoverPane() {
    return (
      <Panel title=" DNS cutover " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          {selected.map((s) => (
            <box key={s.sourceSiteId} style={{ flexDirection: "row", height: 1 }}>
              <text content={s.domain} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
              <box style={{ flexGrow: 1 }} />
              <text content="○ pending" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
            </box>
          ))}
          <box style={{ flexGrow: 1 }} />
          <text content="Batched, partial-aware DNS cutover ships in slice 6 (setRecordValue)." fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  // Live clone roster — one row per selected site, sub-step + spinner/✓/✕.
  function clonePane() {
    const done = selected.filter((s) => s.step === "done").length
    const running = selected.filter((s) => !["queued", "done", "error"].includes(s.step)).length
    const errored = selected.filter((s) => s.step === "error").length
    const queued = selected.filter((s) => s.step === "queued").length
    return (
      <Panel title={` Clone sites · ${job!.concurrency} at a time `} active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          {selected.map((s) => {
            const active = !["queued", "done", "error"].includes(s.step)
            return (
              <box key={s.sourceSiteId} style={{ flexDirection: "row", height: 1 }}>
                {active ? <Spinner color={theme.brand} /> : <text content={s.step === "done" ? "✓" : s.step === "error" ? "✕" : "○"} fg={s.step === "done" ? theme.good : s.step === "error" ? theme.bad : theme.textFaint} style={{ flexShrink: 0 }} />}
                <text content={` ${s.domain}`} fg={s.step === "error" ? theme.text : s.step === "done" ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
                <box style={{ flexGrow: 1 }} />
                <text
                  content={s.step === "error" ? truncate(s.error ?? "failed", 30) : s.step === "done" ? "done" : s.step === "queued" ? "queued" : `${s.step}${s.detail ? " · " + s.detail : ""}`}
                  fg={s.step === "error" ? theme.bad : s.step === "done" ? theme.good : theme.textFaint}
                  wrapMode="none"
                  style={{ flexShrink: 0 }}
                />
              </box>
            )
          })}
          <box style={{ flexGrow: 1 }} />
          <text content={`✓ ${done} done · ⠹ ${running} running · ${queued} queued${errored ? ` · ✕ ${errored} failed` : ""}`} fg={theme.textDim} wrapMode="none" />
          {errored > 0 ? <text content="r retry failed · esc background" fg={theme.textFaint} wrapMode="none" /> : <text content="esc — keeps running in the background" fg={theme.textFaint} wrapMode="none" />}
        </box>
      </Panel>
    )
  }

  function hints() {
    if (job!.step === "plan") {
      return [
        { key: "space", label: "toggle" },
        { key: "u", label: "uploads" },
        { key: "t", label: "lower TTL" },
        ...(sudoOn ? [] : [{ key: "S", label: "connect sudo" }]),
        ...(selected.length > 0 ? [{ key: "⏎", label: "continue" }] : []),
        { key: "esc", label: "close" },
      ]
    }
    if (job!.step === "server") {
      return [{ key: "⏎", label: "provision" }, ...(devDest ? [{ key: "d", label: "dev: use existing" }] : []), { key: "esc", label: "close" }]
    }
    if (job!.step === "trust") {
      const destServer = job!.destServerId != null ? servers.find((s) => s.id === job!.destServerId) ?? null : null
      const both = isSudoConnected(server!.id) && destServer != null && isSudoConnected(destServer.id)
      return [
        { key: "S", label: "sudo dest" },
        { key: "G", label: "sudo source" },
        { key: "w", label: "SpinupWP" },
        ...(both ? [{ key: "⏎", label: "continue" }] : []),
        { key: "esc", label: "close" },
      ]
    }
    return [{ key: "esc", label: "close" }]
  }

  function countDone(step: "clone" | "cutover") {
    if (step === "clone") return job!.sites.filter((s) => s.selected && s.step === "done").length
    return 0
  }
  function totalSize() {
    const known = job!.sites.filter((s) => s.selected && s.sizeBytes != null).reduce((a, s) => a + (s.sizeBytes ?? 0), 0)
    return known > 0 ? formatBytes(known) : "—"
  }
  function payloadLine() {
    const anySized = job!.sites.some((s) => s.sizeBytes != null)
    if (!sudoOn) return "Payload size — connect sudo (S) to measure webroot + DB"
    if (!anySized) return "Measuring webroot + DB sizes over sudo…"
    return `Payload ~${totalSize()} (selected sites' webroot + DB)`
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…"
}
function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`
  return `${(b / 1e3).toFixed(0)} KB`
}

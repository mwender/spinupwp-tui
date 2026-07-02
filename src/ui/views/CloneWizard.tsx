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
import { useStore, cloneNeedsGitAccess, cloneSiteSupported, type CloneStep, type CloneSiteStep, type RepoKeyState } from "../store.tsx"
import type { VerifyCheck } from "../../lib/serverClone.ts"

// Choosing an existing server as the dest is a first-class feature now (the `d` picker
// on the Destination step). SPINUP_DEV_CLONE_DEST just pre-points the picker cursor at
// a given server id — a dev convenience for repeated testing, never required.
const DEV_CLONE_DEST = Number(process.env.SPINUP_DEV_CLONE_DEST) || null
// Dev-only: auto-connect sudo on both ends from .env (SPINUP_DEV_SUDO_SOURCE/DEST,
// each "user:password"), so the full clone is testable headlessly without typing
// passwords into SudoConnect. The real flow never reads these.
const DEV_SUDO = { source: process.env.SPINUP_DEV_SUDO_SOURCE || "", dest: process.env.SPINUP_DEV_SUDO_DEST || "" }

const STEP_PLAN = { step: "plan" as CloneStep, label: "Plan" }
const STEP_SERVER = { step: "server" as CloneStep, label: "Destination" }
const STEP_TRUST = { step: "trust" as CloneStep, label: "Connect dest" }
const STEP_GITACCESS = { step: "gitaccess" as CloneStep, label: "Git access" }
const STEP_CLONE = { step: "clone" as CloneStep, label: "Clone sites" }
const STEP_CUTOVER = { step: "cutover" as CloneStep, label: "DNS cutover" }
// The Git-access step only appears when a Bedrock site is selected (deploy-key onboarding).
function stepsFor(needsGit: boolean): { step: CloneStep; label: string }[] {
  return needsGit
    ? [STEP_PLAN, STEP_SERVER, STEP_TRUST, STEP_GITACCESS, STEP_CLONE, STEP_CUTOVER]
    : [STEP_PLAN, STEP_SERVER, STEP_TRUST, STEP_CLONE, STEP_CUTOVER]
}
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
    cloneDetectRepoKeys,
    cloneAddRepoKey,
    cloneGitAccessContinue,
    cloneSizeSites,
    startClone,
    cloneRetrySite,
    cloneContinueToCutover,
    verifyCloneSite,
    cutoverCheck,
    startCutover,
    cloneCutoverFinish,
    backgroundClone,
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
  const [verifyOpen, setVerifyOpen] = useState<number | null>(null) // slice 5: drilled-into site
  const [pickExisting, setPickExisting] = useState(false) // dest step: choosing an existing server
  const [destIdx, setDestIdx] = useState(0) // cursor in the existing-server picker

  // Kick the fan-out once, when we land on the Clone step. Guarded by the job's
  // fanoutStarted flag (not component state) so reopening a backgrounded wizard
  // never re-queues a clone that's already running in the store.
  useEffect(() => {
    if (job?.step === "clone" && !job.fanoutStarted) {
      setIdx(0)
      startClone()
    }
  }, [job?.step, job?.fanoutStarted, startClone])

  // Detect deploy keys once, when we land on the Git-access step.
  const detectTried = useRef(false)
  useEffect(() => {
    if (job?.step === "gitaccess" && !detectTried.current) {
      detectTried.current = true
      void cloneDetectRepoKeys()
    }
  }, [job?.step, cloneDetectRepoKeys])

  // Read + classify each site's DNS record when we land on the cutover step — but
  // only if it hasn't been checked yet (so reopening a backgrounded wizard doesn't
  // reset in-progress flips). The check itself is read-only.
  useEffect(() => {
    if (job?.step !== "cutover") return
    const cloned = job.sites.filter((s) => s.selected && s.step === "done")
    if (cloned.length > 0 && cloned.every((s) => !s.cutover)) void cutoverCheck()
  }, [job?.step, job?.sites, cutoverCheck])

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

  // Existing servers eligible as a clone destination (anything but the source),
  // name-sorted. The DEV override (SPINUP_DEV_CLONE_DEST) just pre-points the cursor.
  const eligibleDests = servers.filter((s) => s.id !== job?.sourceServerId).slice().sort((a, b) => a.name.localeCompare(b.name))

  useKeyboard((key) => {
    if (!job || !server) return
    // A layered overlay (NewServer / SudoConnect) owns the keyboard while open.
    if (newServerOpen || sudoConnectServer) return
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw

    if (name === "escape" || name === "q") {
      if (verifyOpen != null) return setVerifyOpen(null) // back out of the verify drill-down first
      if (pickExisting) return setPickExisting(false) // back out of the server picker first
      // Once the fan-out has launched, esc BACKGROUNDS the clone (it keeps running);
      // reopen with C on the source server. Before launch / at the summary, esc cancels.
      if (job.step === "clone" || job.step === "cutover") return backgroundClone()
      return close()
    }

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
      if (pickExisting) {
        const n = eligibleDests.length
        if (n === 0) return
        if (name === "up" || name === "k") return setDestIdx((i) => (i - 1 + n) % n)
        if (name === "down" || name === "j") return setDestIdx((i) => (i + 1) % n)
        if (name === "return") {
          const chosen = eligibleDests[destIdx]
          if (chosen) {
            setPickExisting(false)
            cloneSetDest(chosen)
          }
        }
        return
      }
      // d — choose an existing server as the destination (open the picker).
      if (name === "d" && eligibleDests.length > 0) {
        const start = devDest ? Math.max(0, eligibleDests.findIndex((s) => s.id === devDest.id)) : 0
        setDestIdx(start)
        return setPickExisting(true)
      }
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

    if (job.step === "gitaccess") {
      const keys = job.repoKeys ?? []
      // a — add the dest key to every repo we can auto-add (gh + GitHub) that's missing.
      if (name === "a") {
        for (const k of keys) if (k.auto && (k.status === "missing" || k.status === "error")) void cloneAddRepoKey(k.repo)
        return
      }
      // r — re-detect (after a manual add, or to retry a check).
      if (name === "r") {
        detectTried.current = false
        void cloneDetectRepoKeys()
        return
      }
      // o — open the first repo's deploy-keys settings page (manual path).
      if (name === "o") {
        const url = keys.find((k) => k.settingsUrl)?.settingsUrl
        if (url) return openUrl(url)
        return
      }
      // ⏎ — continue once no auto repo is still missing/in-flight (create verifies the rest).
      if (name === "return") {
        const blocked = keys.some((k) => k.status === "checking" || k.status === "adding" || (k.auto && k.status === "missing"))
        if (!blocked) return cloneGitAccessContinue()
      }
      return
    }

    if (job.step === "clone" || job.step === "done") {
      const sel = job.sites.filter((s) => s.selected)
      // While drilled into a verify/failure view: v re-runs verify (done sites),
      // r retries the drilled FAILED site, ←/Esc(handled above) goes back.
      if (verifyOpen != null) {
        const drilled = job.sites.find((s) => s.sourceSiteId === verifyOpen)
        if (name === "r" && drilled?.step === "error") {
          setVerifyOpen(null)
          return cloneRetrySite(verifyOpen)
        }
        if (name === "v" && drilled?.step === "done") return verifyCloneSite(verifyOpen)
        if (name === "left" || name === "h") return setVerifyOpen(null)
        return
      }
      const n = sel.length
      if (n > 0 && (name === "up" || name === "k")) return setIdx((i) => (i - 1 + n) % n)
      if (n > 0 && (name === "down" || name === "j")) return setIdx((i) => (i + 1) % n)
      const cur = sel[idx]
      // v / Enter — verify the highlighted DONE site (drill in + run the comparison).
      if ((name === "v" || name === "return") && cur && cur.step === "done") {
        setVerifyOpen(cur.sourceSiteId)
        verifyCloneSite(cur.sourceSiteId)
        return
      }
      // Enter on a FAILED site — drill into the full (untruncated) error.
      if (name === "return" && cur && cur.step === "error") {
        setVerifyOpen(cur.sourceSiteId)
        return
      }
      // r — retry every failed site.
      if (name === "r") {
        for (const s of job.sites) if (s.selected && s.step === "error") cloneRetrySite(s.sourceSiteId)
        return
      }
      // c — the explicit continue to DNS cutover (only once the roster settled
      // with at least one success; cutover moves live traffic).
      if (name === "c" && job.step === "clone") {
        const settled = sel.length > 0 && sel.every((s) => s.step === "done" || s.step === "error")
        if (settled && sel.some((s) => s.step === "done")) return cloneContinueToCutover()
      }
    }

    if (job.step === "cutover") {
      // c — flip every "ready" record to the new server (the live-traffic write).
      if (name === "c") return startCutover()
      if (name === "r") return void cutoverCheck()
      if (name === "return") return cloneCutoverFinish()
    }
  })

  if (!server || !job) return null

  const selected = job.sites.filter((s) => s.selected)
  const sudoOn = isSudoConnected(server.id)
  const steps = stepsFor(cloneNeedsGitAccess(job))
  const curStepIdx = job.step === "done" ? steps.length : steps.findIndex((s) => s.step === job.step)

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 218 }}>
      {/* header */}
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="✦ Clone server  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={`${server.name} (${selected.length} of ${job.sites.length} sites) → ${job.destServerName || "destination"}`} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
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
        {steps.map((s, i) => {
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
    if (job!.step === "gitaccess") return gitAccessPane()
    if ((job!.step === "clone" || job!.step === "done") && verifyOpen != null) {
      const drilled = job!.sites.find((s) => s.sourceSiteId === verifyOpen)
      return drilled?.step === "error" ? failurePane(verifyOpen) : verifyPane(verifyOpen)
    }
    if (job!.step === "clone" || job!.step === "done") return clonePane()
    if (job!.step === "cutover") return cutoverPane()
    // error — scaffolding for now.
    return (
      <Panel title={` ${steps[curStepIdx]?.label ?? job!.step} `} active>
        <box style={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }}>
          <text content="This step is built in a later slice of the wizard." fg={theme.textDim} wrapMode="none" />
          <text content="The Plan is captured; the rail shows where we are." fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function serverPane() {
    if (pickExisting) return pickExistingPane()
    const sp = job!.specs
    const canPick = eligibleDests.length > 0
    return (
      <Panel title=" Destination — provision new or pick existing " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content="Where should the cloned sites land?" fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="❯ Enter — provision a NEW server" fg={theme.brand} wrapMode="none" />
          <text content={`    matched to source: ${sp.providerName || "—"} · ${sp.region || "—"} · ${sp.size || "—"}`} fg={theme.textFaint} wrapMode="none" />
          <box style={{ height: 1 }} />
          {canPick ? (
            <text content={`❯ d — use an EXISTING server (${eligibleDests.length} available)`} fg={theme.brand} wrapMode="none" />
          ) : (
            <text content="d — use an existing server (none available — provision one)" fg={theme.textFaint} wrapMode="none" />
          )}
          <text content="    e.g. a pre-built box, or consolidate onto an existing server" fg={theme.textFaint} wrapMode="none" />
          <box style={{ flexGrow: 1 }} />
          <text content="Provisioning runs in the background and the wizard waits for it." fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  // Existing-server picker (the promoted "use an existing destination" feature).
  function pickExistingPane() {
    return (
      <Panel title=" Destination — pick an existing server " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content="Clone INTO one of your existing servers:" fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          {eligibleDests.map((s, i) => {
            const sel = i === destIdx
            const meta = `${s.provider_name || "—"} · ${s.region || "—"}${s.ip_address ? "  " + s.ip_address : ""}`
            return (
              <box key={s.id} style={{ flexDirection: "row", height: 1, backgroundColor: sel ? theme.bgAlt : undefined }}>
                <text content={sel ? "❯ " : "  "} fg={theme.brand} style={{ flexShrink: 0 }} />
                <text content={s.name} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
                <box style={{ flexGrow: 1 }} />
                <text content={meta} fg={sel ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
              </box>
            )
          })}
          <box style={{ flexGrow: 1 }} />
          <text content="The dest needs a sudo connection next (and a deploy key for Bedrock) — the wizard walks you through it." fg={theme.textFaint} wrapMode="none" />
          <text content="↑↓ select · ⏎ use this server · esc back" fg={theme.textFaint} wrapMode="none" />
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

  // Git-access step — deploy-key onboarding for Bedrock dests (hybrid: gh auto-add
  // when possible, manual key + settings link otherwise).
  function gitAccessPane() {
    const destServer = job!.destServerId != null ? servers.find((s) => s.id === job!.destServerId) ?? null : null
    const pub = destServer?.git_publickey ?? ""
    const keys = job!.repoKeys ?? []
    const anyManual = keys.some((k) => !k.auto)
    const blocked = keys.some((k) => k.status === "checking" || k.status === "adding" || (k.auto && k.status === "missing"))
    const glyph = (k: RepoKeyState): { g: string; c: string } => {
      switch (k.status) {
        case "present":
        case "added":
          return { g: "✓", c: theme.good }
        case "missing":
          return { g: "○", c: theme.warn }
        case "checking":
        case "adding":
          return { g: "⠹", c: theme.brand }
        case "error":
          return { g: "✕", c: theme.bad }
        default:
          return { g: "•", c: theme.textFaint }
      }
    }
    const label = (k: RepoKeyState): string => {
      switch (k.status) {
        case "present":
          return "deploy key present"
        case "added":
          return "deploy key added"
        case "missing":
          return "deploy key missing — press a to add"
        case "checking":
          return "checking…"
        case "adding":
          return "adding…"
        case "error":
          return truncate(k.error ?? "failed", 36)
        default:
          return "add the key by hand, then r to re-check"
      }
    }
    return (
      <Panel title=" Git access — authorize the new server to pull your repos " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content="A Bedrock dest is cloned from git at create time using the new" fg={theme.textFaint} wrapMode="none" />
          <text content="server's deploy key — it must be a read-only key on each repo." fg={theme.textFaint} wrapMode="none" />
          <box style={{ height: 1 }} />
          {keys.length === 0 ? <text content="Checking repositories…" fg={theme.textDim} wrapMode="none" /> : null}
          {keys.map((k) => {
            const { g, c } = glyph(k)
            return (
              <box key={k.repo} style={{ flexDirection: "row", height: 1 }}>
                <text content={`${g} `} fg={c} style={{ flexShrink: 0 }} />
                <text content={`${k.owner}/${k.name}`} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
                <box style={{ flexGrow: 1 }} />
                <text content={label(k)} fg={k.status === "error" ? theme.bad : k.status === "present" || k.status === "added" ? theme.good : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
              </box>
            )
          })}
          {anyManual && pub ? (
            <>
              <box style={{ height: 1 }} />
              <text content="Add this read-only deploy key in each repo's settings (o opens it):" fg={theme.textFaint} wrapMode="none" />
              <text content={pub} fg={theme.textDim} wrapMode="none" />
            </>
          ) : null}
          <box style={{ flexGrow: 1 }} />
          {blocked ? (
            <text content="Add the missing deploy keys (a), then continue." fg={theme.textFaint} wrapMode="none" />
          ) : (
            <text content="❯ Enter — repos authorized, continue to clone" fg={theme.brand} wrapMode="none" />
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
            const supported = cloneSiteSupported(s)
            const tag = s.stack === "bedrock" ? "bedrock" : !supported ? "not WP" : ""
            const note = !supported ? " (nothing to clone)" : !s.selected ? " (skipped)" : s.excludeUploads ? " (no uploads)" : ""
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

  // DNS cutover roster (slice 6) — one row per A record across the cloned sites'
  // domains (primary + additional). www CNAMEs that follow the apex aren't listed.
  function cutoverPane() {
    const cloned = selected.filter((s) => s.step === "done")
    const recs = cloned.flatMap((s) => (s.cutover?.records ?? []).map((r) => ({ r, siteId: s.sourceSiteId })))
    const count = (st: string) => recs.filter((x) => x.r.status === st).length
    const ready = count("ready")
    const working = count("checking") + count("flipping")
    const cutDone = count("done")
    const manual = count("manual")
    const errored = count("error")
    const targetIp = job!.destServerIp || (job!.destServerId != null ? servers.find((s) => s.id === job!.destServerId)?.ip_address ?? "" : "") || "the new server"
    const rowFor = ({ r, siteId }: (typeof recs)[number]) => {
      const st = r.status
      const busy = st === "checking" || st === "flipping"
      const glyph = st === "done" ? "✓" : st === "manual" ? "!" : st === "error" ? "✕" : st === "ready" ? "○" : "·"
      const gcolor = st === "done" ? theme.good : st === "manual" ? theme.warn : st === "error" ? theme.bad : st === "ready" ? theme.brand : theme.textFaint
      const detail =
        st === "checking" ? "reading DNS…"
        : st === "flipping" ? "updating…"
        : st === "done" ? `now → ${r.targetValue ?? targetIp}`
        : st === "ready" ? `${r.currentValue ?? "?"} → ${r.targetValue ?? targetIp}`
        : st === "manual" ? `manual: ${r.reason ?? "edit by hand"}`
        : st === "error" ? truncate(r.error ?? "failed", 28)
        : "pending"
      const dcolor = st === "error" ? theme.bad : st === "done" ? theme.good : st === "manual" ? theme.warn : theme.textFaint
      return (
        <box key={`${siteId}|${r.name}`} style={{ flexDirection: "row", height: 1 }}>
          {busy ? <Spinner color={theme.brand} /> : <text content={glyph} fg={gcolor} style={{ flexShrink: 0 }} />}
          <text content={` ${r.name}`} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
          <box style={{ flexGrow: 1 }} />
          <text content={detail} fg={dcolor} wrapMode="none" style={{ flexShrink: 0 }} />
        </box>
      )
    }
    return (
      <Panel title=" DNS cutover — point traffic at the new server " active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <text content={`Repoint each A record → ${targetIp}. This moves LIVE traffic (www CNAMEs follow the apex).`} fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          {recs.length === 0 ? <text content="Reading DNS…" fg={theme.textDim} wrapMode="none" /> : recs.map(rowFor)}
          <box style={{ flexGrow: 1 }} />
          <text content={`✓ ${cutDone} cut over · ○ ${ready} ready · ⠹ ${working} working${manual ? ` · ! ${manual} manual` : ""}${errored ? ` · ✕ ${errored} failed` : ""}`} fg={theme.textDim} wrapMode="none" />
          {manual > 0 ? <text content="Manual records can't be API-edited — repoint them in your DNS host." fg={theme.textFaint} wrapMode="none" /> : null}
          {ready > 0 ? (
            <text content={`❯ c — cut over ${ready} record${ready === 1 ? "" : "s"} to the new server (live traffic)`} fg={theme.brand} wrapMode="none" />
          ) : (
            <text content="⏎ — finish" fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  // Live clone roster — one row per selected site, sub-step + spinner/✓/✕.
  function clonePane() {
    const done = selected.filter((s) => s.step === "done").length
    const settled = selected.length > 0 && selected.every((s) => s.step === "done" || s.step === "error")
    const running = selected.filter((s) => !["queued", "done", "error"].includes(s.step)).length
    const errored = selected.filter((s) => s.step === "error").length
    const queued = selected.filter((s) => s.step === "queued").length
    return (
      <Panel title={` Clone sites · ${job!.concurrency} at a time `} active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          {selected.map((s, i) => {
            const active = !["queued", "done", "error"].includes(s.step)
            const cur = i === idx
            const vmark = s.verify ? (s.verify.ok ? " ✓verified" : " ✕mismatch") : s.verifying ? " verifying…" : ""
            return (
              <box key={s.sourceSiteId} style={{ flexDirection: "row", height: 1, backgroundColor: cur ? theme.bgAlt : undefined }}>
                {active ? <Spinner color={theme.brand} /> : <text content={s.step === "done" ? "✓" : s.step === "error" ? "✕" : "○"} fg={s.step === "done" ? theme.good : s.step === "error" ? theme.bad : theme.textFaint} style={{ flexShrink: 0 }} />}
                <text content={` ${s.domain}`} fg={cur || s.step === "error" || s.step === "done" ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
                <box style={{ flexGrow: 1 }} />
                <text
                  content={(s.step === "error" ? truncate(s.error ?? "failed", 24) : s.step === "done" ? "done" : s.step === "queued" ? "queued" : `${s.step}${s.detail ? " · " + s.detail : ""}`) + vmark}
                  fg={s.step === "error" || (s.verify && !s.verify.ok) ? theme.bad : s.verify?.ok ? theme.good : s.step === "done" ? theme.good : theme.textFaint}
                  wrapMode="none"
                  style={{ flexShrink: 0 }}
                />
              </box>
            )
          })}
          <box style={{ flexGrow: 1 }} />
          <text content={`✓ ${done} done · ⠹ ${running} running · ${queued} queued${errored ? ` · ✕ ${errored} failed` : ""}`} fg={theme.textDim} wrapMode="none" />
          {done > 0 ? <text content="↑↓ select · v verify a done site" fg={theme.textFaint} wrapMode="none" /> : null}
          {errored > 0 ? <text content={`⏎ on a failed site — full error${job!.logPath ? ` · log: ${job!.logPath}` : ""}`} fg={theme.textFaint} wrapMode="none" /> : null}
          {settled && done > 0 && job!.step === "clone" ? (
            <text content={`❯ c — continue to DNS cutover (${done} of ${selected.length} cloned; cutover moves LIVE traffic)`} fg={theme.brand} wrapMode="none" />
          ) : null}
          {job!.step === "clone" ? (
            <text content={errored > 0 ? "r retry failed · esc — clone keeps running in the background" : "esc — clone keeps running in the background (reopen with C)"} fg={theme.textFaint} wrapMode="none" />
          ) : (
            <text content={errored > 0 ? "r retry failed · esc close" : "esc — close"} fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  // Verify drill-down (slice 5) — source-vs-clone facts + HTTP for one done site.
  function verifyPane(siteId: number) {
    const site = job!.sites.find((s) => s.sourceSiteId === siteId)
    if (!site) return null
    const v = site.verify
    const row = (c: VerifyCheck) => (
      <box key={c.key} style={{ flexDirection: "row", height: 1 }}>
        <text content={c.ok ? "✓ " : "✕ "} fg={c.ok ? theme.good : theme.bad} style={{ flexShrink: 0 }} />
        <text content={c.label} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={truncate(c.source, 22)} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 0, width: 24 }} />
        <text content={truncate(c.clone, 22)} fg={c.ok ? theme.textDim : theme.bad} wrapMode="none" style={{ flexShrink: 0, width: 24 }} />
      </box>
    )
    return (
      <Panel title={` Verify · ${site.domain} `} active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          {site.verifying ? (
            <box style={{ flexDirection: "row", height: 1 }}>
              <Spinner color={theme.brand} />
              <text content=" Comparing source vs clone…" fg={theme.textDim} wrapMode="none" />
            </box>
          ) : site.verifyError ? (
            <text content={`Verify failed: ${site.verifyError}`} fg={theme.bad} wrapMode="none" />
          ) : v ? (
            <>
              <box style={{ flexDirection: "row", height: 1 }}>
                <text content=" " style={{ flexShrink: 0 }} />
                <text content="check" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
                <box style={{ flexGrow: 1 }} />
                <text content="source" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0, width: 24 }} />
                <text content="clone" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0, width: 24 }} />
              </box>
              {v.checks.map(row)}
              <box style={{ flexGrow: 1 }} />
              <text content={v.ok ? "✓ Clone matches the source." : "✕ Differences found — review the ✕ rows above."} fg={v.ok ? theme.good : theme.bad} wrapMode="none" />
              <text content="v re-run · ← back to roster" fg={theme.textFaint} wrapMode="none" />
            </>
          ) : (
            <text content="Press v to compare this clone against its source." fg={theme.textDim} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  // Failure drill-down — the FULL error for one failed site (the roster truncates it),
  // plus where the complete stage-by-stage log lives on disk.
  function failurePane(siteId: number) {
    const site = job!.sites.find((s) => s.sourceSiteId === siteId)
    if (!site) return null
    return (
      <Panel title={` Failed · ${site.domain} `} active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <box style={{ flexDirection: "row", height: 1 }}>
            <text content="✕ failed at: " fg={theme.bad} style={{ flexShrink: 0 }} />
            <text content={site.failedStep ?? "?"} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
          <box style={{ height: 1 }} />
          <text content={site.error ?? "no error captured"} fg={theme.text} />
          <box style={{ flexGrow: 1 }} />
          {job!.logPath ? <text content={`Full stage-by-stage output: ${job!.logPath}`} fg={theme.textFaint} /> : null}
          <text content="r retry this site · ← back to roster" fg={theme.textFaint} wrapMode="none" />
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
      if (pickExisting) return [{ key: "↑↓", label: "select" }, { key: "⏎", label: "use server" }, { key: "esc", label: "back" }]
      return [{ key: "⏎", label: "provision new" }, ...(eligibleDests.length > 0 ? [{ key: "d", label: "use existing" }] : []), { key: "esc", label: "close" }]
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
    if (job!.step === "clone" || job!.step === "done") {
      if (verifyOpen != null) {
        const drilled = job!.sites.find((s) => s.sourceSiteId === verifyOpen)
        if (drilled?.step === "error") return [{ key: "r", label: "retry site" }, { key: "←", label: "back" }, { key: "esc", label: "close" }]
        return [{ key: "v", label: "re-run" }, { key: "←", label: "back" }, { key: "esc", label: "close" }]
      }
      const done = selected.filter((s) => s.step === "done").length
      const errored = selected.filter((s) => s.step === "error").length
      const settled = selected.length > 0 && selected.every((s) => s.step === "done" || s.step === "error")
      return [
        ...(settled && done > 0 && job!.step === "clone" ? [{ key: "c", label: "DNS cutover" }] : []),
        ...(done > 0 ? [{ key: "↑↓", label: "select" }, { key: "v", label: "verify" }] : []),
        ...(errored > 0 ? [{ key: "r", label: "retry failed" }] : []),
        { key: "esc", label: job!.step === "clone" ? "background" : "close" },
      ]
    }
    if (job!.step === "cutover") {
      const ready = selected.filter((s) => s.step === "done").flatMap((s) => s.cutover?.records ?? []).filter((r) => r.status === "ready").length
      return [
        ...(ready > 0 ? [{ key: "c", label: "cut over" }] : []),
        { key: "r", label: "re-check" },
        { key: "⏎", label: "finish" },
        { key: "esc", label: "background" },
      ]
    }
    if (job!.step === "gitaccess") {
      const keys = job!.repoKeys ?? []
      const canAdd = keys.some((k) => k.auto && (k.status === "missing" || k.status === "error"))
      const hasManual = keys.some((k) => k.settingsUrl)
      const blocked = keys.some((k) => k.status === "checking" || k.status === "adding" || (k.auto && k.status === "missing"))
      return [
        ...(canAdd ? [{ key: "a", label: "add key" }] : []),
        ...(hasManual ? [{ key: "o", label: "open settings" }] : []),
        { key: "r", label: "re-check" },
        ...(!blocked ? [{ key: "⏎", label: "continue" }] : []),
        { key: "esc", label: "close" },
      ]
    }
    return [{ key: "esc", label: "close" }]
  }

  function countDone(step: "clone" | "cutover") {
    if (step === "clone") return job!.sites.filter((s) => s.selected && s.step === "done").length
    // cutover badge counts records repointed (or already on the new IP).
    return job!.sites.filter((s) => s.selected && s.cutover?.status === "done").length
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

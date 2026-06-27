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

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { Panel } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, type CloneStep, type CloneSiteStep } from "../store.tsx"

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
    toggleCloneSite,
    toggleCloneSiteUploads,
    cloneAdvanceFromPlan,
    toggleCloneLowerTtl,
    clearClone,
    isSudoConnected,
    setSudoConnectServer,
  } = useStore()

  const [idx, setIdx] = useState(0)

  const close = () => clearClone()

  useKeyboard((key) => {
    if (!job || !server) return
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw

    // Connect sudo on the source from any step (pre-flight + later the pull need it).
    if (name === "S" && !isSudoConnected(server.id)) return setSudoConnectServer(server)
    if (name === "escape" || name === "q") return close()

    if (job.step === "plan") {
      const n = job.sites.length
      if (name === "up" || name === "k") return setIdx((i) => (i - 1 + n) % n)
      if (name === "down" || name === "j") return setIdx((i) => (i + 1) % n)
      const cur = job.sites[idx]
      if (name === "space" && cur) return toggleCloneSite(cur.sourceSiteId)
      if (name === "u" && cur) return toggleCloneSiteUploads(cur.sourceSiteId)
      if (name === "t") return toggleCloneLowerTtl()
      if (name === "return") return cloneAdvanceFromPlan()
    }
  })

  if (!server || !job) return null

  const selected = job.sites.filter((s) => s.selected)
  const sudoOn = isSudoConnected(server.id)
  const curStepIdx = STEPS.findIndex((s) => s.step === job.step)

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
    if (job!.step === "clone" || job!.step === "cutover") return rosterPane(job!.step)
    // server / trust / done / error — scaffolding for now.
    return (
      <Panel title={` ${STEPS[curStepIdx]?.label ?? job!.step} `} active>
        <box style={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }}>
          <text content="This step is built in a later slice of the wizard." fg={theme.textDim} wrapMode="none" />
          <text content="The Plan is captured; the rail shows where we are." fg={theme.textFaint} wrapMode="none" />
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
          <text content={`Payload ~${totalSize()} · sizing runs during the clone (slice 4)`} fg={theme.textFaint} wrapMode="none" />
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

  // Read-only roster preview (the fan-out the later slices animate).
  function rosterPane(step: "clone" | "cutover") {
    const cols: CloneSiteStep[] = ["create", "pull", "config", "verify"]
    return (
      <Panel title={step === "clone" ? " Clone sites " : " DNS cutover "} active>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
          <box style={{ flexDirection: "row", height: 1 }}>
            <text content="SITE" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
            <box style={{ flexGrow: 1 }} />
            <text content={step === "clone" ? "db  files  cfg  ✓" : "zone        cutover"} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
          </box>
          {selected.map((s) => (
            <box key={s.sourceSiteId} style={{ flexDirection: "row", height: 1 }}>
              <text content={s.domain} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
              <box style={{ flexGrow: 1 }} />
              <text content={step === "clone" ? "○   ○     ○    ○" : "—           ○ pending"} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
            </box>
          ))}
          <box style={{ flexGrow: 1 }} />
          <text content="Roster fills in once the clone orchestration ships (slices 4–6)." fg={theme.textFaint} wrapMode="none" />
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
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…"
}
function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`
  return `${(b / 1e3).toFixed(0)} KB`
}

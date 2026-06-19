// Local working-copy discovery overlay — Phase 2.
//
// Opened with `S` (Stacks). Scans the configured roots for local copies and
// matches them to sites (git remote → WP_HOME → folder name). Flow:
//   • needRoot — no scan roots configured yet: a one-field prompt to add one
//                (inline, so the opt-in scan is self-sufficient — no JSON editing).
//   • scanning — running the (read-only) scan.
//   • review   — batch list of proposed links; toggle which to accept, then apply.
//   • empty    — nothing new found; add another root or close.
// Accepting a proposal calls the same store.linkSite used by the manual `L` flow;
// a WP_HOME discovered during the scan prefills the link's local URL.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { moveSelection } from "../List.tsx"
import { scanRoots, type Proposal, type Confidence } from "../../lib/discover.ts"

type Phase = "needRoot" | "scanning" | "review" | "empty" | "done"

function confColor(c: Confidence): string {
  return c === "high" ? theme.good : c === "medium" ? theme.accent : theme.warn
}

export function Discover() {
  const store = useStore()
  const { sites, localLinks, localRoots, addLocalRoot, linkSite, setDiscoverOpen, setInputMode } = store

  const [phase, setPhase] = useState<Phase>(() => (localRoots.length === 0 ? "needRoot" : "scanning"))
  const [rootInput, setRootInput] = useState("")
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [scannedDirs, setScannedDirs] = useState(0)
  const [accepted, setAccepted] = useState<Set<number>>(new Set())
  const [index, setIndex] = useState(0)
  const [linkedCount, setLinkedCount] = useState(0)

  // Run a read-only scan against an explicit root list (avoids state-timing races
  // when a root was just added), then route to review / empty.
  const runScan = (roots: string[]) => {
    setPhase("scanning")
    void scanRoots(roots, sites, new Set(localLinks.keys())).then((res) => {
      setProposals(res.proposals)
      setScannedDirs(res.scannedDirs)
      setAccepted(new Set(res.proposals.map((_, i) => i))) // default: accept all
      setIndex(0)
      setPhase(res.proposals.length > 0 ? "review" : "empty")
    })
  }

  // Kick the initial scan once (if roots already exist).
  useEffect(() => {
    if (localRoots.length > 0) runScan(localRoots)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The prompt owns the keyboard while adding a root.
  useEffect(() => {
    setInputMode(phase === "needRoot")
    return () => setInputMode(false)
  }, [phase, setInputMode])

  const close = () => {
    setInputMode(false)
    setDiscoverOpen(false)
  }

  const submitRoot = () => {
    // Accept several comma-separated folders at once.
    const dirs = rootInput.split(",").map((d) => d.trim()).filter(Boolean)
    if (dirs.length === 0) return
    for (const d of dirs) addLocalRoot(d)
    setRootInput("")
    // Scan the union (dedup) so newly-added roots take effect immediately.
    runScan([...new Set([...localRoots, ...dirs])])
  }

  const apply = () => {
    let n = 0
    for (let i = 0; i < proposals.length; i++) {
      if (!accepted.has(i)) continue
      const p = proposals[i]
      linkSite(p.site.id, { domain: p.site.domain, path: p.path, localUrl: p.localUrl ?? "" })
      n++
    }
    setLinkedCount(n)
    setPhase("done")
  }

  useKeyboard((key) => {
    const name = key.name ?? ""

    if (phase === "needRoot") {
      if (name === "escape") return close()
      return // the input handles typing + Enter
    }
    if (name === "escape" || name === "q") return close()

    if (phase === "review") {
      switch (name) {
        case "up":
        case "k":
          return setIndex((i) => moveSelection(i, -1, proposals.length))
        case "down":
        case "j":
          return setIndex((i) => moveSelection(i, 1, proposals.length))
        case "space":
          return setAccepted((prev) => {
            const next = new Set(prev)
            next.has(index) ? next.delete(index) : next.add(index)
            return next
          })
        case "a":
          return setAccepted((prev) =>
            prev.size === proposals.length ? new Set() : new Set(proposals.map((_, i) => i)),
          )
        case "return":
        case "y":
          return apply()
      }
      return
    }

    if (phase === "empty") {
      if (name === "+" || name === "=") {
        setRootInput("")
        setPhase("needRoot")
      }
      return
    }
  })

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
        zIndex: 220,
      }}
    >
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="🔍 Discover local copies  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={localRoots.length > 0 ? `${localRoots.length} scan root${localRoots.length === 1 ? "" : "s"}` : "no roots yet"} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      {phase === "review" ? renderReview() : <Centered>{renderCentered()}</Centered>}

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderCentered() {
    if (phase === "needRoot") {
      return (
        <Panel title=" Add a directory to scan " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <text content="Where do you keep your local working copies?" fg={theme.text} wrapMode="none" />
            <text content="The parent folder(s) — their subdirectories get matched to sites." fg={theme.textDim} wrapMode="none" />
            <text content="Separate multiple folders with commas." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <input
              focused
              value={rootInput}
              placeholder="~/code,  ~/sites/bedrock"
              onInput={setRootInput}
              onSubmit={submitRoot}
              style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
            />
            <box style={{ height: 1 }} />
            <text content="Enter to scan · Esc to cancel" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    if (phase === "scanning") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content="  Scanning for local copies…" fg={theme.textDim} />
        </box>
      )
    }
    if (phase === "empty") {
      return (
        <Panel title=" Nothing new found " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`Scanned ${scannedDirs} director${scannedDirs === 1 ? "y" : "ies"} — no new matches.`} fg={theme.text} wrapMode="none" />
            <text content="Already-linked sites are skipped." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="+ add another scan directory · Esc to close" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }
    // done
    return (
      <Panel title=" Done " active>
        <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="✓ " fg={theme.good} />
            <text content={`Linked ${linkedCount} local cop${linkedCount === 1 ? "y" : "ies"}.`} fg={theme.text} wrapMode="none" />
          </box>
          <box style={{ height: 1 }} />
          <text content="Esc to close" fg={theme.textFaint} />
        </box>
      </Panel>
    )
  }

  function renderReview() {
    return (
      <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
        <text
          content={`Found ${proposals.length} local cop${proposals.length === 1 ? "y" : "ies"} in ${scannedDirs} director${scannedDirs === 1 ? "y" : "ies"}. Space toggles, a all, Enter links the checked.`}
          fg={theme.textDim}
          wrapMode="none"
        />
        <box style={{ height: 1 }} />
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          {proposals.map((p, i) => {
            const sel = i === index
            const on = accepted.has(i)
            return (
              <box key={p.site.id} style={{ flexDirection: "row", height: 1, backgroundColor: sel ? theme.selectedBg : undefined }}>
                <text content={on ? "[✓] " : "[ ] "} fg={sel ? theme.text : on ? theme.good : theme.textFaint} style={{ flexShrink: 0 }} />
                <text content={truncate(p.site.domain, 34)} fg={sel ? theme.text : theme.text} wrapMode="none" style={{ flexShrink: 0 }} />
                <text content="  ← " fg={theme.textFaint} style={{ flexShrink: 0 }} />
                <text content={p.path} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                <text content={`  ${p.reason}`} fg={sel ? theme.text : confColor(p.confidence)} wrapMode="none" style={{ flexShrink: 0 }} />
              </box>
            )
          })}
        </box>
      </box>
    )
  }

  function hints() {
    switch (phase) {
      case "needRoot":
        return [
          { key: "⏎", label: "scan" },
          { key: "esc", label: "cancel" },
        ]
      case "review":
        return [
          { key: "↑↓/jk", label: "move" },
          { key: "space", label: "toggle" },
          { key: "a", label: "all/none" },
          { key: "⏎/y", label: "link checked" },
          { key: "esc", label: "cancel" },
        ]
      case "empty":
        return [
          { key: "+", label: "add root" },
          { key: "esc", label: "close" },
        ]
      default:
        return [{ key: "esc", label: "close" }]
    }
  }
}

// "Needs a local copy" report — Phase 4a (the forgotten report).
//
// The inverse of discovery (`S`, which finds copies that exist on disk): this
// lists WordPress/Bedrock sites you have NO usable local copy for — either never
// linked, or linked to a path that's gone missing. It's the direct answer to the
// original pain ("I forget which managed sites have a local copy and miss
// composer updates"). Read-only; from a row you jump straight into linking it.
//
// Defaults to the ACTIONABLE set (sites with pending updates, plus missing-path
// links) so it's a short to-do list rather than a dump of every unlinked site;
// `a` toggles the full list. Opened with `f` (Stacks). Drift (git ahead/behind,
// PHP mismatch) is a later pass.

import { useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme, statusColor, statusDot } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { effectiveStack, stackColor, stackTag, type Stack } from "../../lib/stack.ts"
import { resolveLocalLink } from "../../lib/local.ts"
import { Panel } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import type { Site } from "../../api/types.ts"

interface Entry {
  site: Site
  updates: number
  missing: boolean // linked, but the path is gone
}

// Stack filter options the report can cycle through (← / →). null = all stacks.
const STACK_FILTERS: (Stack | null)[] = [null, "Standard WP", "Bedrock", "Non-WP"]

export function Forgotten() {
  const { sites, localLinks, probes, setForgottenOpen, setLocalLinkSite, forgottenStack, setLinkReturnToForgotten } = useStore()
  const { height } = useTerminalDimensions()
  // Default shows every site in the filter without a local copy; this trims to
  // the "needs attention" subset (pending updates or a missing path).
  const [needsAttentionOnly, setNeedsAttentionOnly] = useState(false)
  const [index, setIndex] = useState(0)
  // Stack filter is adjustable in-report (← / →), seeded from the Stacks group
  // that was selected when opened (Non-WP / no WP group → "All").
  const [stackFilter, setStackFilter] = useState<Stack | null>(forgottenStack)

  // WP/Bedrock sites without a usable local copy.
  const all = useMemo<Entry[]>(() => {
    const out: Entry[] = []
    for (const s of sites) {
      const stack = effectiveStack(s, probes.get(s.id)?.result.kind)
      if (stackFilter && stack !== stackFilter) continue // active stack filter (adjustable)
      const link = localLinks.get(s.id)
      let missing = false
      if (link) {
        if (resolveLocalLink(link).exists) continue // has a copy → not forgotten
        missing = true
      }
      const updates = (s.wp_plugin_updates || 0) + (s.wp_theme_updates || 0) + (s.wp_core_update ? 1 : 0)
      out.push({ site: s, updates, missing })
    }
    // Alphabetical by domain (consistent with the discovery list).
    out.sort((a, b) => a.site.domain.localeCompare(b.site.domain))
    return out
  }, [sites, localLinks, probes, stackFilter])

  const actionable = useMemo(() => all.filter((e) => e.updates > 0 || e.missing), [all])
  const shown = needsAttentionOnly ? actionable : all
  const safeIndex = Math.min(index, Math.max(0, shown.length - 1))

  const close = () => setForgottenOpen(false)

  useKeyboard((key) => {
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw
    switch (name) {
      case "escape":
      case "q":
        return close()
      case "up":
      case "k":
        return setIndex((i) => moveSelection(i, -1, shown.length))
      case "down":
      case "j":
        return setIndex((i) => moveSelection(i, 1, shown.length))
      case "left":
      case "right": {
        const dir = name === "right" ? 1 : -1
        const i = STACK_FILTERS.findIndex((s) => s === stackFilter)
        setStackFilter(STACK_FILTERS[(i + dir + STACK_FILTERS.length) % STACK_FILTERS.length])
        return setIndex(0)
      }
      case "a":
        setNeedsAttentionOnly((v) => !v)
        return setIndex(0)
      case "L":
      case "return": {
        const e = shown[safeIndex]
        if (e) {
          close()
          setLinkReturnToForgotten(true) // come back here when the link overlay closes
          setLocalLinkSite(e.site) // jump straight into linking it
        }
        return
      }
    }
  })

  const listRows = Math.max(3, height - 5)

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 215 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content={`📦 Needs a local copy · ${stackFilter ?? "All"}  `} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={needsAttentionOnly ? `${actionable.length} need attention` : `${all.length} without a local copy`} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
        {shown.length === 0 ? (
          <text
            content={
              all.length === 0
                ? "✓ Every site here has a local copy."
                : "✓ Nothing needs attention — press a to show all without a local copy."
            }
            fg={theme.good}
            wrapMode="none"
          />
        ) : (
          <List
            items={shown}
            selectedIndex={safeIndex}
            viewportRows={listRows}
            focused
            keyFor={(e) => e.site.id}
            emptyText="—"
            renderRow={(e, selected) => {
              const stack = effectiveStack(e.site, probes.get(e.site.id)?.result.kind)
              return (
                <>
                  <text content={statusDot(e.site.status) + " "} fg={statusColor(e.site.status)} style={{ flexShrink: 0 }} />
                  <text content={truncate(e.site.domain, 44)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  {e.missing && <text content="missing copy " fg={selected ? theme.text : theme.bad} style={{ flexShrink: 0 }} />}
                  {e.updates > 0 && <text content={`↑${e.updates} `} fg={selected ? theme.text : theme.warn} style={{ flexShrink: 0 }} />}
                  <text content={stackTag(stack) + " "} fg={stackColor(stack, selected)} style={{ flexShrink: 0 }} />
                </>
              )
            }}
          />
        )}
      </box>

      <StatusBar
        hints={[
          { key: "↑↓/jk", label: "select" },
          { key: "←→", label: "stack" },
          { key: "L/⏎", label: "link this site" },
          { key: "a", label: needsAttentionOnly ? "show all" : "needs attention only" },
          { key: "esc", label: "close" },
        ]}
        showGlobal={false}
      />
    </box>
  )
}

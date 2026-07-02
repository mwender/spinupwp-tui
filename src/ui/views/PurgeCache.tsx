// Purge page cache + object cache overlay — mirrors HttpsToggle.tsx's
// confirm→tracking→done/error shape. There's no enable/disable for either
// cache on an existing site (only at site-creation time, per the SpinupWP
// API), so purge is the only available write; one confirm fires both
// purge-page-cache and purge-object-cache together. Opened with `P` (capital
// — lowercase `p` is already the DB-pull action in Search) on a selected site.
//
// The writes + event polling live in the store (startPurgeCache), so closing
// this overlay (Esc/q) doesn't abandon them.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, isPurgeCacheInFlight, purgeCacheFailed } from "../store.tsx"

type Phase = "confirm" | "tracking" | "done" | "error"

function subLabel(status: string): string {
  return status === "deployed" ? "done" : status === "failed" ? "failed" : status || "queued"
}

export function PurgeCache() {
  const store = useStore()
  const { purgeCacheSite: site, setPurgeCacheSite, purgeCacheProgress, startPurgeCache, clearPurgeCache } = store

  const [phase, setPhase] = useState<Phase>("confirm")
  const progress = site ? purgeCacheProgress.get(site.id) : undefined
  const dp: Phase =
    phase !== "tracking"
      ? phase
      : !progress
        ? "tracking"
        : purgeCacheFailed(progress)
          ? "error"
          : isPurgeCacheInFlight(progress)
            ? "tracking"
            : "done"

  const close = () => {
    if (site && purgeCacheFailed(progress)) clearPurgeCache(site.id)
    setPurgeCacheSite(null)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()

    if (dp === "confirm") {
      if (name === "y") {
        if (site) {
          startPurgeCache(site)
          setPhase("tracking")
        }
        return
      }
      return
    }

    if (dp === "error") {
      if (name === "r") {
        if (site) clearPurgeCache(site.id)
        setPhase("confirm")
      }
      return
    }
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
        <text content="🗑 Purge cache  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "confirm") {
      return (
        <Panel title=" Confirm: purge cache " active>
          <box style={{ flexDirection: "column", width: 60, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Purge page cache + object cache for " fg={theme.text} wrapMode="none" />
            </box>
            <text content={truncate(site!.domain, 32)} fg={theme.accent} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Clears both caches; SpinupWP rebuilds them on the next" fg={theme.textDim} wrapMode="none" />
            <text content="page load. Low-risk and fully reversible by nature." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press y to confirm · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "tracking") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Purging…" fg={theme.textDim} />
          </box>
          <box style={{ height: 1 }} />
          <text content={`Page cache: ${subLabel(progress?.page.status ?? "queued")}`} fg={theme.textDim} wrapMode="none" />
          <text content={`Object cache: ${subLabel(progress?.object.status ?? "queued")}`} fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="You can press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }

    if (dp === "done") {
      return (
        <Panel title=" Done " active>
          <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ " fg={theme.good} />
              <text content={truncate(site!.domain, 32)} fg={theme.accent} wrapMode="none" />
              <text content=" — cache purged" fg={theme.text} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    // error
    return (
      <Panel title=" Failed " active>
        <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ Page cache: ${progress?.page.error ?? subLabel(progress?.page.status ?? "")}`} fg={theme.bad} wrapMode="none" />
          <text content={`✕ Object cache: ${progress?.object.error ?? subLabel(progress?.object.status ?? "")}`} fg={theme.bad} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Press r to try again · Esc to close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "confirm":
        return [
          { key: "y", label: "confirm" },
          { key: "esc", label: "cancel" },
        ]
      case "error":
        return [
          { key: "r", label: "retry" },
          { key: "esc", label: "close" },
        ]
      default:
        return [{ key: "esc", label: "close" }]
    }
  }
}

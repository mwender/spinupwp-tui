// Production media fallback overlay.
//
// Opened with `m` on a linked WordPress site (Search), or from the `p` sync Done
// screen. Toggles a small mu-plugin in the local copy that serves missing-locally
// uploads from production — so a synced site's images resolve without pulling the
// whole media library. The plugin's presence IS the on/off state (no config), so
// this is just a file write/remove; nothing runs in the background.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered, DestPath, Sparkle } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { enableMediaFallback, disableMediaFallback } from "../../lib/mediaFallback.ts"

export function MediaFallback() {
  const { mediaFallbackSite: site, setMediaFallbackSite, planMediaFallbackFor } = useStore()
  // Re-resolve every render so the panel reflects the file on disk after a toggle.
  const planResult = site ? planMediaFallbackFor(site) : null
  const [changed, setChanged] = useState<"enabled" | "disabled" | "updated" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const plan = planResult && planResult.ok ? planResult.plan : null

  const close = () => setMediaFallbackSite(null)

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()
    if (!plan) return
    try {
      if (!plan.enabled && (name === "return" || name === "y")) {
        enableMediaFallback(plan)
        setChanged("enabled")
        setError(null)
      } else if (plan.enabled && plan.updateAvailable && name === "u") {
        enableMediaFallback(plan) // overwrite in place with the current version
        setChanged("updated")
        setError(null)
      } else if (plan.enabled && name === "x") {
        disableMediaFallback(plan)
        setChanged("disabled")
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update the media-fallback plugin.")
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
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="🖼 Production media fallback  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 38)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content="local only" fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (!plan) {
      return (
        <Panel title=" Can't set up media fallback " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <text content={planResult && !planResult.ok ? planResult.error : "Unavailable."} fg={theme.warn} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    return (
      <Panel title=" Serve missing images from production " active>
        <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
          {plan.enabled && plan.updateAvailable && changed !== "updated" ? (
            <box
              title=" ✨ Update available "
              titleColor={theme.brand}
              border
              borderColor={theme.brand}
              style={{ flexDirection: "column", width: 66, paddingLeft: 1, paddingRight: 1, marginBottom: 1 }}
            >
              <box style={{ flexDirection: "row" }}>
                <Sparkle />
                <text content={`  Newer missing-images plugin ready (v${plan.installedVersion} → v${plan.version}).`} fg={theme.text} wrapMode="none" />
              </box>
              <text content="Now covers legacy /wp-content/uploads paths, CDN/S3" fg={theme.textDim} wrapMode="none" />
              <text content="redirects, and Elementor gallery URLs." fg={theme.textDim} wrapMode="none" />
              <box style={{ flexDirection: "row" }}>
                <text content="Press " fg={theme.textDim} />
                <text content="u" fg={theme.brand} />
                <text content=" to update in place." fg={theme.textDim} />
              </box>
            </box>
          ) : null}
          <text content="When an upload is missing locally, its URL is rewritten to" fg={theme.textDim} wrapMode="none" />
          <text content="production — so images resolve without syncing the library." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <box style={{ flexDirection: "row" }}>
            <text content="source " fg={theme.textFaint} />
            <text content={plan.prodOrigin} fg={theme.accent} wrapMode="none" />
            <text content={`  (${plan.stack === "bedrock" ? "Bedrock" : "Standard WP"})`} fg={theme.textFaint} wrapMode="none" />
          </box>
          <text content="plugin" fg={theme.textFaint} />
          <DestPath path={plan.pluginPath} fileColor={plan.enabled ? theme.good : theme.textDim} width={64} />
          <box style={{ height: 1 }} />
          {renderStatus()}
          <box style={{ height: 1 }} />
          <text content="Needs production reachable + hotlinking allowed (no staging" fg={theme.textFaint} wrapMode="none" />
          <text content="Basic-Auth / hotlink protection). Read-only on production." fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderStatus() {
    if (error) return <text content={`✕ ${error}`} fg={theme.bad} />
    if (plan!.enabled) {
      const note =
        changed === "updated"
          ? `  — updated to v${plan!.version}. Reload the local site.`
          : changed === "enabled"
            ? "  — enabled. Reload the local site; images now load from production."
            : "  — missing images load from production."
      return (
        <>
          <box style={{ flexDirection: "row" }}>
            <text content="● ON" fg={theme.good} />
            <text content={note} fg={theme.text} wrapMode="none" />
          </box>
          <text content="Press x to turn off" fg={theme.textFaint} />
        </>
      )
    }
    return (
      <>
        <box style={{ flexDirection: "row" }}>
          <text content="○ OFF" fg={theme.textDim} />
          <text content={changed === "disabled" ? "  — removed. Missing images will 404 locally again." : "  — missing images 404 locally."} fg={theme.text} wrapMode="none" />
        </box>
        <text content="Press y / ⏎ to turn on" fg={theme.textFaint} />
      </>
    )
  }

  function hints() {
    if (!plan) return [{ key: "esc", label: "close" }]
    if (!plan.enabled)
      return [
        { key: "y/⏎", label: "turn on" },
        { key: "esc", label: "close" },
      ]
    return [
      ...(plan.updateAvailable && changed !== "updated" ? [{ key: "u", label: "update" }] : []),
      { key: "x", label: "turn off" },
      { key: "esc", label: "close" },
    ]
  }
}

// Enable/disable HTTPS overlay — mirrors PhpUpgrade.tsx's confirm→tracking→
// done/error shape, minus the picker phase: the direction (enable vs disable)
// is fully determined by the site's current https.enabled, so there's nothing
// to choose, just confirm. Opened with `H` on a selected site.
//
// The write + event polling live in the store (startHttpsToggle), so closing
// this overlay (Esc/q) doesn't abandon it — the site's row keeps a marker
// until it settles.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"

type Phase = "confirm" | "tracking" | "done" | "error"

export function HttpsToggle() {
  const store = useStore()
  const { httpsToggleSite: site, setHttpsToggleSite, httpsToggles, startHttpsToggle, clearHttpsToggle } = store

  const action: "enable" | "disable" = site?.https?.enabled ? "disable" : "enable"
  const [phase, setPhase] = useState<Phase>("confirm")

  // Background progress for this site, owned by the store. Once fired
  // ("tracking"), the screen follows the store's event status.
  const progress = site ? httpsToggles.get(site.id) : undefined
  const dp: Phase =
    phase !== "tracking"
      ? phase
      : !progress
        ? "done"
        : progress.status === "failed"
          ? "error"
          : "tracking"

  const close = () => {
    // Leave an in-flight toggle running (its row keeps the marker); only drop
    // a settled failure so it doesn't linger after the user has seen it.
    if (site && progress?.status === "failed") clearHttpsToggle(site.id)
    setHttpsToggleSite(null)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()

    if (dp === "confirm") {
      if (name === "y") {
        if (site) {
          startHttpsToggle(site)
          setPhase("tracking")
        }
        return
      }
      return
    }

    if (dp === "error") {
      if (name === "r") {
        if (site) clearHttpsToggle(site.id)
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
        <text content={`${action === "enable" ? "🔒" : "🔓"} ${action === "enable" ? "Enable" : "Disable"} HTTPS  `} fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "confirm") {
      return action === "enable" ? (
        <Panel title=" Confirm: enable HTTPS " active>
          <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Enable HTTPS for " fg={theme.text} />
              <text content={truncate(site!.domain, 32)} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Issues a free Let's Encrypt certificate. The domain must" fg={theme.textDim} wrapMode="none" />
            <text content="already resolve to this server, or issuance will fail." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press y to confirm · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      ) : (
        <Panel title=" Confirm: disable HTTPS " active>
          <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Disable HTTPS for " fg={theme.text} />
              <text content={truncate(site!.domain, 32)} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Removes the certificate. Visitors on https:// will start" fg={theme.warn} wrapMode="none" />
            <text content="seeing connection/certificate errors until re-enabled." fg={theme.warn} wrapMode="none" />
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
            <text content={`  ${action === "enable" ? "Enabling" : "Disabling"} HTTPS — ${progress?.status ?? "queued"}…`} fg={theme.textDim} />
          </box>
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
              <text content={` — HTTPS ${action === "enable" ? "enabled" : "disabled"}`} fg={theme.text} wrapMode="none" />
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
          <text content={`✕ ${progress?.error ?? "Something went wrong."}`} fg={theme.bad} />
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

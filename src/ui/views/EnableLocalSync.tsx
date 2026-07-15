// "Enable local sync?" confirm overlay — opened when `p` (Pull prod. DB) is
// pressed on a site while the localSync config flag is off. localSync is a
// deliberate opt-in (pulling production overwrites the local database), so
// confirming here only flips the flag and saves it — it does NOT chain into
// the pull itself. The user presses `p` again afterward to actually run it,
// which still has its own confirm-before-firing step. Keeps the destructive
// action behind two deliberate presses, same safety margin as before, while
// making the feature discoverable instead of a silent config-file-only switch.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"

type Phase = "confirm" | "done"

export function EnableLocalSync() {
  const { enableLocalSyncSite: site, setEnableLocalSyncSite, enableLocalSync } = useStore()
  const [phase, setPhase] = useState<Phase>("confirm")

  const close = () => setEnableLocalSyncSite(null)

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (phase === "confirm") {
      if (name === "y") {
        enableLocalSync()
        setPhase("done")
        return
      }
      if (name === "escape" || name === "q") return close()
      return
    }
    // "done" — any key closes.
    return close()
  })

  if (!site) return null

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="↓ Local sync  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={phase === "confirm" ? [{ key: "y", label: "enable" }, { key: "esc", label: "cancel" }] : [{ key: "any", label: "close" }]} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (phase === "confirm") {
      return (
        <Panel title=" Enable local sync? " active>
          <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
            <text content="Local sync is off — it's opt-in because pulling production" fg={theme.text} wrapMode="none" />
            <text content="overwrites your LOCAL database." fg={theme.text} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Enabling it just flips the setting — it won't pull anything" fg={theme.textDim} wrapMode="none" />
            <text content="yet. Press p again afterward to actually pull production." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press y to enable · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    return (
      <Panel title=" Done " active>
        <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="✓ " fg={theme.good} />
            <text content="Local sync enabled" fg={theme.text} wrapMode="none" />
          </box>
          <box style={{ height: 1 }} />
          <text content="Press p again to pull production into your local copy." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Press any key to close" fg={theme.textFaint} />
        </box>
      </Panel>
    )
  }
}

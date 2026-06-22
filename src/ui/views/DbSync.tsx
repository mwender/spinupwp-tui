// Production → local DB sync overlay.
//
// Opened with `p` on a linked WordPress site (Search). Pulls the production
// database into the local working copy: backs up local first, exports/downloads
// prod (read-only), imports it, rewrites URLs, and runs an optional post-import
// hook. DESTRUCTIVE on local — so the confirm screen says so plainly. The work
// runs in the store (`startDbSync`), so closing the modal (Esc/q) doesn't abandon
// it; the row keeps a spinner and reopening shows live progress.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate, middleTruncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered, DestPath } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"

const STAGE_LABEL: Record<string, string> = {
  "local-backup": "Backing up your local database…",
  export: "Exporting the production database…",
  download: "Downloading the dump…",
  import: "Importing into your local database…",
  replace: "Rewriting production URLs → local…",
  hook: "Running the post-import hook…",
}

export function DbSync() {
  const { dbSyncSite: site, setDbSyncSite, serverById, planDbSyncFor, dbSyncs, startDbSync, clearDbSync } = useStore()

  const planResult = site ? planDbSyncFor(site) : null
  const progress = site ? dbSyncs.get(site.id) : undefined
  const [started, setStarted] = useState(false)

  const dp: "blocked" | "confirm" | "running" | "done" | "error" =
    planResult && !planResult.ok && !progress
      ? "blocked"
      : !started && !progress
        ? "confirm"
        : progress?.stage === "done"
          ? "done"
          : progress?.stage === "error"
            ? "error"
            : "running"

  const close = () => {
    if (site && (progress?.stage === "done" || progress?.stage === "error")) clearDbSync(site.id)
    setDbSyncSite(null)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()
    if (dp === "confirm") {
      if (name === "return" || name === "y") {
        if (site) {
          startDbSync(site)
          setStarted(true)
        }
      }
      return
    }
    if (dp === "error") {
      if (name === "r") {
        if (site) clearDbSync(site.id)
        setStarted(false)
      }
      return
    }
  })

  if (!site) return null
  const server = serverById(site.server_id)
  const plan = planResult && planResult.ok ? planResult.plan : null

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
        style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}
      >
        <text content="⇣ Pull production → local  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 38)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content="overwrites local DB" fg={theme.warn} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "blocked") {
      return (
        <Panel title=" Can't sync yet " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <text content={planResult && !planResult.ok ? planResult.error : "Unavailable."} fg={theme.warn} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    if (dp === "confirm") {
      return (
        <Panel title=" Pull production database to local " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="⚠ " fg={theme.warn} />
              <text content="This OVERWRITES your local database." fg={theme.text} wrapMode="none" />
            </box>
            <text content="  (your local DB is backed up first, just in case)" fg={theme.textFaint} wrapMode="none" />
            <box style={{ height: 1 }} />
            <box style={{ flexDirection: "row" }}>
              <text content="from " fg={theme.textFaint} />
              <text content={truncate(site!.domain, 30)} fg={theme.accent} wrapMode="none" />
              <text content=" on " fg={theme.textDim} />
              <text content={truncate(server?.name ?? "—", 22)} fg={theme.textDim} wrapMode="none" />
            </box>
            <text content="into" fg={theme.textFaint} />
            {plan ? <DestPath path={plan.localRoot} fileColor={theme.good} width={64} /> : null}
            <box style={{ height: 1 }} />
            <text content="rewrite URLs" fg={theme.textFaint} />
            <text content={`  ${plan ? middleTruncate(`${plan.remoteOrigin} → ${plan.localOrigin}`, 64) : "—"}`} fg={theme.textDim} wrapMode="none" />
            {plan?.hookPath ? (
              <>
                <box style={{ height: 1 }} />
                <text content="↪ will run bin/sync.d/post-import.sh" fg={theme.purple} wrapMode="none" />
              </>
            ) : null}
            {plan?.prefixWarning ? (
              <>
                <box style={{ height: 1 }} />
                <text content={`⚠ ${plan.prefixWarning}`} fg={theme.warn} wrapMode="none" />
              </>
            ) : null}
            <box style={{ height: 1 }} />
            <text content="Production is only read from — nothing there is modified." fg={theme.textFaint} wrapMode="none" />
            <text content="Press y / ⏎ to pull · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "running") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={`  ${STAGE_LABEL[progress?.stage ?? "local-backup"] ?? "Working…"}`} fg={theme.textDim} />
          </box>
          <box style={{ height: 1 }} />
          <text content="You can press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }

    if (dp === "done") {
      return (
        <Panel title=" Done " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ " fg={theme.good} />
              <text content="Local now mirrors production." fg={theme.text} wrapMode="none" />
              {progress?.ranHook ? <text content="  (hook ran)" fg={theme.textFaint} wrapMode="none" /> : null}
            </box>
            <box style={{ height: 1 }} />
            <text content="prod dump saved" fg={theme.textFaint} />
            {progress?.downloadPath ? <DestPath path={progress.downloadPath} fileColor={theme.accent} width={64} /> : null}
            <text content="local DB backup" fg={theme.textFaint} />
            {progress?.localBackupPath ? <DestPath path={progress.localBackupPath} fileColor={theme.textDim} width={64} /> : null}
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    return (
      <Panel title=" Sync failed " active>
        <box style={{ flexDirection: "column", width: 70, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${progress?.error ?? "Something went wrong."}`} fg={theme.bad} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Your local DB backup is in sql/ if you need to restore." fg={theme.textFaint} wrapMode="none" />
          <text content="Press r to try again · Esc to close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "confirm":
        return [
          { key: "y/⏎", label: "pull" },
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

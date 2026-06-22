// Production DB-backup overlay.
//
// Opened with `d` on a linked site (Search). Confirms what will run, then exports
// the remote database, downloads it (gzipped) into the local project's sql/ dir,
// and cleans up the remote copy. The export + download run in the store
// (`startDbBackup`), so closing this modal (Esc/q) doesn't abandon them — the
// download keeps going and the result is still in the store when reopened.
//
// The whole operation is read-only on production (an export, never a write).

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate, formatBytes, middleTruncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered, DestPath } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"

const STAGE_LABEL: Record<string, string> = {
  export: "Exporting the database on the server…",
  download: "Downloading the backup…",
  cleanup: "Cleaning up the remote copy…",
}

export function DbBackup() {
  const { dbBackupSite: site, setDbBackupSite, serverById, planDbBackupFor, dbBackups, startDbBackup, clearDbBackup } = useStore()

  // Resolve the plan up front so the confirm screen can show source + destination
  // (and surface an unrunnable link before the user commits).
  const planResult = site ? planDbBackupFor(site) : null
  const progress = site ? dbBackups.get(site.id) : undefined

  const [started, setStarted] = useState(false)

  // Display phase: a planning error blocks before anything runs; otherwise the
  // screen follows the store's progress once we've fired the backup.
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
    // Drop a settled (done/failed) entry so reopening starts fresh; leave an
    // in-flight download running with its progress intact.
    if (site && (progress?.stage === "done" || progress?.stage === "error")) clearDbBackup(site.id)
    setDbBackupSite(null)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()

    if (dp === "confirm") {
      if (name === "return" || name === "y") {
        if (site) {
          startDbBackup(site)
          setStarted(true)
        }
      }
      return
    }

    if (dp === "error") {
      if (name === "r") {
        if (site) clearDbBackup(site.id)
        setStarted(false)
      }
      return
    }
  })

  if (!site) return null
  const server = serverById(site.server_id)

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
        <text content="⬇ Download DB backup  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content="read-only export" fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "blocked") {
      return (
        <Panel title=" Can't back up yet " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <text content={planResult && !planResult.ok ? planResult.error : "Unavailable."} fg={theme.warn} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="The backup downloads into the linked working copy's sql/ folder." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    if (dp === "confirm") {
      const plan = planResult && planResult.ok ? planResult.plan : null
      return (
        <Panel title=" Download production database " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Export " fg={theme.text} />
              <text content={truncate(site!.domain, 36)} fg={theme.accent} wrapMode="none" />
              <text content=" on " fg={theme.textDim} />
              <text content={truncate(server?.name ?? "—", 24)} fg={theme.textDim} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="from" fg={theme.textFaint} />
            <text content={`  ${middleTruncate(plan?.docroot ?? "—", 62)}`} fg={theme.textDim} wrapMode="none" />
            <text content="to" fg={theme.textFaint} />
            {plan ? <DestPath path={plan.destPath} fileColor={theme.good} width={62} /> : <text content="  —" fg={theme.textDim} />}
            <box style={{ height: 1 }} />
            <text content="Exports with wp-cli, gzips it, downloads it, then removes the" fg={theme.textDim} wrapMode="none" />
            <text content="remote copy. Nothing on production is modified." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press y / ⏎ to download · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "running") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={`  ${STAGE_LABEL[progress?.stage ?? "export"] ?? "Working…"}`} fg={theme.textDim} />
          </box>
          <box style={{ height: 1 }} />
          <text content="You can press Esc — the download keeps running in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }

    if (dp === "done") {
      return (
        <Panel title=" Done " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ Saved " fg={theme.good} />
              <text content={progress?.bytes != null ? formatBytes(progress.bytes) : ""} fg={theme.text} />
            </box>
            <box style={{ height: 1 }} />
            {progress?.destPath ? <DestPath path={progress.destPath} fileColor={theme.accent} width={62} /> : null}
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    // error
    return (
      <Panel title=" Backup failed " active>
        <box style={{ flexDirection: "column", width: 70, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${progress?.error ?? "Something went wrong."}`} fg={theme.bad} wrapMode="none" />
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
          { key: "y/⏎", label: "download" },
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

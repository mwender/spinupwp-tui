// WordPress core update — the "WordPress core" branch of the `u` Update menu.
//
// check (SSH, read-only) → pick a version → confirm → update → done/failed. The
// work itself lives in lib/wpCore.ts; the job is tracked in ../wpCoreJobs.tsx, so
// Esc doesn't abandon it: the SSH run keeps going, a toast reports the outcome,
// and reopening the overlay on the same site picks the job back up.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { moveSelection } from "../List.tsx"
import type { Site } from "../../api/types.ts"
import { checkWpCore, type WpCoreStatus } from "../../lib/wpCore.ts"
import { setCoreJob, startCoreUpdate, useWpCoreJob } from "../wpCoreJobs.tsx"

// ---- view -------------------------------------------------------------------

type Phase = "checking" | "checkError" | "upToDate" | "pick" | "confirm"

export function WpCoreUpdate({ site, onBack, onClose }: { site: Site; onBack: () => void; onClose: () => void }) {
  const { serverById, sshUser, noteWpVersion } = useStore()
  const server = serverById(site.server_id)
  const job = useWpCoreJob(site.id)

  const [phase, setPhase] = useState<Phase>("checking")
  const [status, setStatus] = useState<WpCoreStatus | null>(null)
  const [checkError, setCheckError] = useState("")
  const [index, setIndex] = useState(0)
  const [nonce, setNonce] = useState(0) // bump to re-check

  useEffect(() => {
    if (!server) {
      setCheckError("This site's server isn't loaded.")
      setPhase("checkError")
      return
    }
    let live = true
    setPhase("checking")
    void checkWpCore(server, site, sshUser).then((res) => {
      if (!live) return
      if (!res.ok) {
        setCheckError(`${res.error} (${res.target})`)
        setPhase("checkError")
        return
      }
      setStatus(res.status)
      // A fresh live read — correct any stale row while we're here, update or not.
      noteWpVersion(site, res.status.current)
      // Land on the first minor (security/maintenance) release when there is one
      // — the usual reason to be here — rather than a major jump.
      const minor = res.status.offers.findIndex((o) => o.updateType === "minor")
      setIndex(minor >= 0 ? minor : 0)
      setPhase(res.status.offers.length ? "pick" : "upToDate")
    })
    return () => {
      live = false
    }
    // Keyed on ids, not objects: a background store refresh hands back a new
    // server object, and re-checking then would yank the user out of pick/confirm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id, site.id, sshUser, nonce])

  const offers = status?.offers ?? []
  const target = offers[index]
  // A job for this site overrides the local flow: running → progress; settled → its result.
  const view: Phase | "running" | "done" | "failed" = job ? (job.result === null ? "running" : job.result.ok ? "done" : "failed") : phase

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") {
      if (job?.result) setCoreJob(site.id, null) // the outcome's been seen — don't replay it next time
      return onClose()
    }
    if (view === "done" || view === "failed") {
      if (name === "r" || (view === "done" && (name === "left" || name === "h"))) {
        setCoreJob(site.id, null)
        setNonce((n) => n + 1)
      }
      return
    }
    if (view === "running") return
    if (view === "checking" || view === "checkError" || view === "upToDate") {
      if (name === "left" || name === "h") return onBack()
      if (name === "r" && view !== "checking") setNonce((n) => n + 1)
      return
    }
    if (view === "pick") {
      switch (name) {
        case "up":
        case "k":
          return setIndex((i) => moveSelection(i, -1, offers.length))
        case "down":
        case "j":
          return setIndex((i) => moveSelection(i, 1, offers.length))
        case "left":
        case "h":
          return onBack()
        case "return":
        case "right":
        case "l":
          if (target) setPhase("confirm")
          return
      }
      return
    }
    if (view === "confirm") {
      if (name === "y" && server && status && target) startCoreUpdate(server, site, sshUser, target.version, status.multisite, noteWpVersion)
      else if (name === "left" || name === "h") setPhase("pick")
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
        zIndex: 210,
      }}
    >
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="⬆ Update WordPress  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={status ? `current WP ${status.current}` : ""} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function composerLines(): string[] {
    if (!status?.composer) return []
    const pin = status.composer.lockedVersion ? `composer.lock pins ${status.composer.lockedVersion}` : "Composer manages core"
    return [
      `Core is installed by Composer (${pin}). This patches the`,
      "files on the server only — the next composer install (a deploy,",
      "a clone) puts the locked version back. Run composer update and",
      "commit the lock to make it stick.",
    ]
  }

  function renderBody() {
    if (view === "checking") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content="  Checking WordPress over SSH…" fg={theme.textDim} />
        </box>
      )
    }

    if (view === "checkError") {
      return (
        <Panel title=" Couldn't check WordPress " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`✕ ${checkError}`} fg={theme.bad} />
            <box style={{ height: 1 }} />
            <text content="r to retry · ← back · Esc to close" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (view === "upToDate") {
      return (
        <Panel title=" Up to date " active>
          <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ " fg={theme.good} />
              <text content={`WordPress ${status?.current} is the latest version.`} fg={theme.text} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="r to re-check · ← back · Esc to close" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (view === "pick") {
      return (
        <Panel title=" Choose a WordPress version " active>
          <box style={{ flexDirection: "column", width: 56 }}>
            {offers.map((o, i) => {
              const selected = i === index
              const tag = o.updateType ? `  (${o.updateType})` : ""
              return (
                <box key={o.version} style={{ flexDirection: "row", height: 1, backgroundColor: selected ? theme.selectedBg : undefined }}>
                  <text content={(selected ? "❯ " : "  ") + `WordPress ${o.version}`} fg={selected ? theme.text : theme.textDim} style={{ flexGrow: 1 }} wrapMode="none" />
                  <text content={tag} fg={selected ? theme.text : o.updateType === "major" ? theme.warn : theme.textFaint} style={{ flexShrink: 0 }} />
                </box>
              )
            })}
            <box style={{ height: 1 }} />
            <text content={`Installed: WordPress ${status?.current}`} fg={theme.textFaint} wrapMode="none" />
            {status?.composer ? <text content="Composer-managed core — see the note on the next screen." fg={theme.warn} wrapMode="none" /> : null}
          </box>
        </Panel>
      )
    }

    if (view === "confirm" && target && status) {
      return (
        <Panel title=" Confirm update " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Update " fg={theme.text} />
              <text content={truncate(site.domain, 40)} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ flexDirection: "row" }}>
              <text content={`from WordPress ${status.current}`} fg={theme.textDim} />
              <text content="  →  " fg={theme.textFaint} />
              <text content={`WordPress ${target.version}`} fg={theme.good} />
            </box>
            <box style={{ height: 1 }} />
            <text content={`Runs wp core update, then the database upgrade${status.multisite ? " (network-wide)" : ""}.`} fg={theme.textDim} wrapMode="none" />
            {target.updateType === "major" ? <text content="Major release — test plugins and themes against it." fg={theme.warn} wrapMode="none" /> : null}
            {composerLines().length ? <box style={{ height: 1 }} /> : null}
            {composerLines().map((l) => (
              <text key={l} content={l} fg={theme.warn} wrapMode="none" />
            ))}
            <box style={{ height: 1 }} />
            <text content="Press y to confirm · ← to go back · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (view === "running") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={`  Updating to WordPress ${job?.version}…`} fg={theme.textDim} />
          </box>
          <box style={{ height: 1 }} />
          <text content="You can press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }

    if (view === "done" && job?.result?.ok) {
      return (
        <Panel title=" Done " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ " fg={theme.good} />
              <text content={truncate(site.domain, 32)} fg={theme.accent} wrapMode="none" />
              <text content={` is now on WordPress ${job.result.after}`} fg={theme.text} wrapMode="none" />
            </box>
            <text content={`(was ${job.result.before})`} fg={theme.textFaint} wrapMode="none" />
            {composerLines().length ? <box style={{ height: 1 }} /> : null}
            {composerLines().map((l) => (
              <text key={l} content={l} fg={theme.warn} wrapMode="none" />
            ))}
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    // failed
    const result = job?.result && !job.result.ok ? job.result : null
    const tail = (result?.log ?? "").split("\n").filter(Boolean).slice(-8)
    return (
      <Panel title=" Update failed " active>
        <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${result?.error ?? "Something went wrong."}`} fg={theme.bad} />
          {tail.length ? <box style={{ height: 1 }} /> : null}
          {tail.map((l, i) => (
            <text key={i} content={truncate(l, 74)} fg={theme.textDim} wrapMode="none" />
          ))}
          <box style={{ height: 1 }} />
          <text content="Press r to re-check the site · Esc to close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (view) {
      case "pick":
        return [
          { key: "↑↓/jk", label: "version" },
          { key: "⏎", label: "choose" },
          { key: "←", label: "back" },
          { key: "esc", label: "cancel" },
        ]
      case "confirm":
        return [
          { key: "y", label: "confirm" },
          { key: "←", label: "back" },
          { key: "esc", label: "cancel" },
        ]
      case "checkError":
      case "upToDate":
        return [
          { key: "r", label: "re-check" },
          { key: "←", label: "back" },
          { key: "esc", label: "close" },
        ]
      case "failed":
        return [
          { key: "r", label: "re-check" },
          { key: "esc", label: "close" },
        ]
      default:
        return [{ key: "esc", label: "close" }]
    }
  }
}

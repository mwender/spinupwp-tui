// Grant SSH key overlay — a privileged write-over-SSH on a sudo-connected server.
//
// Opened with `K` on a selected site (Browser). Deploys Spinup's dedicated machine
// key into the site user's authorized_keys, via the server's SUDO session — the one
// thing the SpinupWP API can't do. Requires sudo to be connected on the server first
// (press `S` on the server to connect sudo for the session); this overlay then just
// shows the exact remote command, confirms, and fires. The grant runs in the store
// (`startGrantKey`), so closing the modal doesn't abandon it.
// See docs/2026-06-26_sudo-ssh-key-provisioning-spec.md.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, isKeyGrantInFlight } from "../store.tsx"
import { ensureSpinupKey, buildGrantScript } from "../../lib/ssh.ts"

type Phase = "disconnected" | "confirm" | "running" | "done" | "error"

export function GrantKey() {
  const store = useStore()
  const {
    grantKeySite: site,
    setGrantKeySite,
    serverById,
    keyGrants,
    startGrantKey,
    clearGrantKey,
    isSudoConnected,
    sudoUserFor,
    setSudoConnectServer,
  } = store

  const server = serverById(site?.server_id)
  const connected = server ? isSudoConnected(server.id) : false
  const sudoUser = server ? sudoUserFor(server.id) : undefined

  const [phase, setPhase] = useState<Phase>(() => {
    if (site && keyGrants.has(site.id)) return "running"
    return connected ? "confirm" : "disconnected"
  })

  // The dedicated machine key's public-key comment, for display (lazy-resolved).
  const [keyComment, setKeyComment] = useState<string>("")

  const progress = site ? keyGrants.get(site.id) : undefined
  const dp: Phase =
    phase !== "running"
      ? phase
      : !progress || isKeyGrantInFlight(progress)
        ? "running"
        : progress.status === "done"
          ? "done"
          : "error"

  useEffect(() => {
    void ensureSpinupKey()
      .then((k) => setKeyComment(k.comment))
      .catch(() => setKeyComment("spinup-tui"))
  }, [])

  const close = () => {
    if (site && progress && !isKeyGrantInFlight(progress)) clearGrantKey(site.id)
    setGrantKeySite(null)
  }

  const fire = () => {
    if (site) startGrantKey(site)
    setPhase("running")
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()

    if (dp === "disconnected") {
      if (name === "s" && server) {
        // Jump to the connect-sudo overlay for this server; reopening the grant
        // afterwards is on the user (the normal flow is connect-then-grant).
        setGrantKeySite(null)
        setSudoConnectServer(server)
      }
      return
    }

    if (dp === "confirm") {
      if (name === "y") return fire()
      return
    }

    if (dp === "error") {
      if (name === "r") {
        if (site) clearGrantKey(site.id)
        // The server may have been disconnected if the failure was an auth error.
        return setPhase(server && isSudoConnected(server.id) ? "confirm" : "disconnected")
      }
      return
    }
  })

  if (!site) return null

  const siteUser = site.site_user ?? "(no site user)"

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
      {/* Title bar */}
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
        <text content="🔑 Grant SSH key  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={connected ? "● " : "○ "} fg={connected ? theme.good : theme.textFaint} style={{ flexShrink: 0 }} />
        <text content={server?.name ?? "—"} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "disconnected") {
      return (
        <Panel title=" Sudo not connected " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="○ Sudo isn't connected on " fg={theme.warn} wrapMode="none" />
              <text content={server?.name ?? "this server"} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Granting an SSH key is a privileged write, so it needs a" fg={theme.textDim} wrapMode="none" />
            <text content="sudo connection to the server first." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press s to connect sudo now (or S on the server), then" fg={theme.textFaint} wrapMode="none" />
            <text content="press K on the site again." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "confirm") {
      const script = buildGrantScript(siteUser, site!.domain, keyComment ? `…ed25519… ${keyComment}` : "…")
      return (
        <Panel title=" Confirm — privileged write " active>
          <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Add Spinup's machine key to " fg={theme.text} wrapMode="none" />
              <text content={`${siteUser}@${site!.domain}`} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ flexDirection: "row" }}>
              <text content="via sudo as " fg={theme.textDim} wrapMode="none" />
              <text content={sudoUser ?? "—"} fg={theme.good} wrapMode="none" />
              <text content="  ·  key: " fg={theme.textDim} wrapMode="none" />
              <text content={keyComment || "spinup-tui"} fg={theme.textDim} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Runs on the server (idempotent — re-running is a no-op):" fg={theme.textFaint} wrapMode="none" />
            <box style={{ flexDirection: "column", backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1 }}>
              {script.split("\n").map((line, i) => (
                <text key={i} content={line} fg={theme.textDim} wrapMode="none" />
              ))}
            </box>
            <box style={{ height: 1 }} />
            <text content="This is Spinup's most powerful write. Press y to continue." fg={theme.warn} wrapMode="none" />
            <text content="y confirm · Esc cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "running") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Granting the key over SSH…" fg={theme.textDim} />
          </box>
          <box style={{ height: 1 }} />
          <text content="You can press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }

    if (dp === "done") {
      return (
        <Panel title=" Done " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ Spinup's key is on " fg={theme.good} wrapMode="none" />
              <text content={progress?.target ?? `${siteUser}@${site!.domain}`} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Spinup can now reach this site over SSH without a checkbox" fg={theme.textDim} wrapMode="none" />
            <text content="in the SpinupWP UI. Esc to close." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // error
    return (
      <Panel title=" Grant failed " active>
        <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${progress?.error ?? "Something went wrong."}`} fg={theme.bad} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="r retry · Esc close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "disconnected":
        return [
          { key: "s", label: "connect sudo" },
          { key: "esc", label: "close" },
        ]
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

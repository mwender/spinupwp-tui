// Grant SSH key overlay — a privileged write-over-SSH on a sudo-connected server.
//
// Opened with `K` on a selected site (Browser). Pick which key(s) to deploy into
// the site user's authorized_keys — your PERSONAL key(s) (so you can SSH/SFTP as
// yourself) and/or Spinup's dedicated `spinup-tui` MACHINE key (for unattended
// automation) — then confirm and grant via the server's SUDO session. Requires sudo
// to be connected first (press `S` on the server). The grant runs in the store
// (`startGrantKey`), so closing the modal doesn't abandon it.
// See docs/2026-06-26_sudo-ssh-key-provisioning-spec.md.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, isKeyGrantInFlight } from "../store.tsx"
import { ensureSpinupKey, listPersonalKeys, buildGrantScript, keyBody, type GrantableKey } from "../../lib/ssh.ts"
import { moveSelection } from "../List.tsx"

type Phase = "disconnected" | "loading" | "pick" | "confirm" | "running" | "done" | "error"

export function GrantKey() {
  const store = useStore()
  const {
    grantKeySite: site,
    setGrantKeySite,
    serverById,
    keyGrants,
    startGrantKey,
    clearGrantKey,
    preferredGrantKeys,
    setPreferredGrantKeys,
    isSudoConnected,
    sudoUserFor,
    setSudoConnectServer,
  } = store

  const server = serverById(site?.server_id)
  const connected = server ? isSudoConnected(server.id) : false
  const sudoUser = server ? sudoUserFor(server.id) : undefined

  const [phase, setPhase] = useState<Phase>(() => {
    if (site && keyGrants.has(site.id)) return "running"
    return connected ? "loading" : "disconnected"
  })
  const [keys, setKeys] = useState<GrantableKey[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [index, setIndex] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Resolve the grantable keys once (machine key + discovered personal keys).
  // Personal keys first (the daily-driver default for single-site), machine last.
  useEffect(() => {
    if (phase !== "loading") return
    let cancelled = false
    void Promise.all([ensureSpinupKey(), listPersonalKeys()])
      .then(([machine, personal]) => {
        if (cancelled) return
        const machineKey: GrantableKey = { id: keyBody(machine.pub), kind: "machine", label: machine.comment, line: machine.pub, source: "spinup" }
        const list = [...personal.filter((p) => p.id !== machineKey.id), machineKey]
        setKeys(list)
        // Pre-select the keys remembered from last time (∩ what's available now);
        // first run defaults to the top personal key (ed25519-first), or the machine
        // key if no personal keys were found on this machine.
        const remembered = list.filter((k) => preferredGrantKeys.includes(k.id)).map((k) => k.id)
        setSelected(new Set(remembered.length > 0 ? remembered : [personal[0]?.id ?? machineKey.id]))
        setPhase("pick")
      })
      .catch((err) => {
        if (!cancelled) {
          setKeys([])
          setLoadError((err as Error).message)
          setPhase("error")
        }
      })
    return () => {
      cancelled = true
    }
  }, [phase])

  const progress = site ? keyGrants.get(site.id) : undefined
  const dp: Phase =
    phase !== "running"
      ? phase
      : !progress || isKeyGrantInFlight(progress)
        ? "running"
        : progress.status === "done"
          ? "done"
          : "error"

  const selectedKeys = keys.filter((k) => selected.has(k.id))

  const close = () => {
    if (site && progress && !isKeyGrantInFlight(progress)) clearGrantKey(site.id)
    setGrantKeySite(null)
  }

  const fire = () => {
    if (site && selectedKeys.length > 0) {
      startGrantKey(site, selectedKeys.map((k) => k.line))
      setPreferredGrantKeys(selectedKeys.map((k) => k.id)) // remember the choice
    }
    setPhase("running")
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()

    if (dp === "disconnected") {
      if (name === "s" && server) {
        setGrantKeySite(null)
        setSudoConnectServer(server)
      }
      return
    }

    if (dp === "pick") {
      switch (name) {
        case "up":
        case "k":
          return setIndex((i) => moveSelection(i, -1, keys.length))
        case "down":
        case "j":
          return setIndex((i) => moveSelection(i, 1, keys.length))
        case "space": {
          const k = keys[index]
          if (!k) return
          return setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(k.id)) next.delete(k.id)
            else next.add(k.id)
            return next
          })
        }
        case "return":
        case "right":
        case "l":
          if (selectedKeys.length > 0) setPhase("confirm")
          return
      }
      return
    }

    if (dp === "confirm") {
      if (name === "y") return fire()
      if (name === "left" || name === "h") return setPhase("pick")
      return
    }

    if (dp === "error") {
      if (name === "r") {
        if (loadError) {
          setLoadError(null)
          return setPhase("loading")
        }
        if (site) clearGrantKey(site.id)
        if (!(server && isSudoConnected(server.id))) return setPhase("disconnected")
        return setPhase(keys.length > 0 ? "pick" : "loading")
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
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="○ Sudo isn't connected on " fg={theme.warn} wrapMode="none" />
              <text content={server?.name ?? "this server"} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Why: each site runs as its own Linux user, and its SSH" fg={theme.textDim} wrapMode="none" />
            <text content="keys live in that user's authorized_keys. Writing another" fg={theme.textDim} wrapMode="none" />
            <text content="user's file needs root — so Spinup logs in as the server's" fg={theme.textDim} wrapMode="none" />
            <text content="sudo user. (The SpinupWP API can't manage SSH keys.)" fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press s to connect sudo now (or S on the server), then" fg={theme.textFaint} wrapMode="none" />
            <text content="press K on the site again." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "loading") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content="  Finding your SSH keys…" fg={theme.textDim} />
        </box>
      )
    }

    if (dp === "pick") {
      return (
        <Panel title=" Choose keys to grant " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Add to " fg={theme.textDim} wrapMode="none" />
              <text content={`${siteUser}@${site!.domain}`} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            {keys.map((k, i) => {
              const sel = i === index
              const checked = selected.has(k.id)
              const tag = k.kind === "machine" ? "machine" : "personal"
              const tagFg = sel ? theme.text : k.kind === "machine" ? theme.brand : theme.accent
              return (
                <box key={k.id} style={{ flexDirection: "row", height: 1, backgroundColor: sel ? theme.selectedBg : undefined }}>
                  <text content={(sel ? "❯ " : "  ") + (checked ? "[x] " : "[ ] ")} fg={checked ? theme.good : theme.textDim} style={{ flexShrink: 0 }} />
                  <text content={truncate(k.label || k.source, 40)} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  <text content={" " + tag} fg={tagFg} style={{ flexShrink: 0 }} />
                </box>
              )
            })}
            <box style={{ height: 1 }} />
            <text content="Personal keys log you in as yourself; the machine key is" fg={theme.textFaint} wrapMode="none" />
            <text content="Spinup's own identity for unattended automation." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "confirm") {
      // Show the exact remote script with abbreviated key reprs (the full base64 is
      // long); the labels make clear which keys land.
      const displayLines = selectedKeys.map((k) => `…${k.kind === "machine" ? "spinup-tui" : "ed25519"}… ${k.label}`)
      const script = buildGrantScript(siteUser, site!.domain, displayLines)
      return (
        <Panel title=" Confirm — privileged write " active>
          <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content={`Add ${selectedKeys.length} key${selectedKeys.length === 1 ? "" : "s"} to `} fg={theme.text} wrapMode="none" />
              <text content={`${siteUser}@${site!.domain}`} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ flexDirection: "row" }}>
              <text content="via sudo as " fg={theme.textDim} wrapMode="none" />
              <text content={sudoUser ?? "—"} fg={theme.good} wrapMode="none" />
            </box>
            {selectedKeys.map((k) => (
              <box key={k.id} style={{ flexDirection: "row" }}>
                <text content="  • " fg={theme.textFaint} wrapMode="none" />
                <text content={truncate(k.label || k.source, 44)} fg={theme.textDim} wrapMode="none" />
                <text content={`  (${k.kind})`} fg={k.kind === "machine" ? theme.brand : theme.accent} wrapMode="none" />
              </box>
            ))}
            <box style={{ height: 1 }} />
            <text content="Runs on the server (idempotent — re-running is a no-op):" fg={theme.textFaint} wrapMode="none" />
            <box style={{ flexDirection: "column", backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1 }}>
              {script.split("\n").map((line, i) => (
                <text key={i} content={line} fg={theme.textDim} wrapMode="none" />
              ))}
            </box>
            <box style={{ height: 1 }} />
            <text content="This is Spinup's most powerful write. Press y to continue." fg={theme.warn} wrapMode="none" />
            <text content="y confirm · ← back · Esc cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "running") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Granting over SSH…" fg={theme.textDim} />
          </box>
          <box style={{ height: 1 }} />
          <text content="You can press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }

    if (dp === "done") {
      return (
        <Panel title=" Done " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ Granted on " fg={theme.good} wrapMode="none" />
              <text content={progress?.target ?? `${siteUser}@${site!.domain}`} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="The selected key(s) are now in the site's authorized_keys." fg={theme.textDim} wrapMode="none" />
            <text content="Esc to close." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // error
    return (
      <Panel title=" Grant failed " active>
        <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${progress?.error ?? loadError ?? "Something went wrong."}`} fg={theme.bad} wrapMode="none" />
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
      case "pick":
        return [
          { key: "↑↓", label: "key" },
          { key: "space", label: "toggle" },
          { key: "⏎", label: "next" },
          { key: "esc", label: "cancel" },
        ]
      case "confirm":
        return [
          { key: "y", label: "confirm" },
          { key: "←", label: "back" },
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

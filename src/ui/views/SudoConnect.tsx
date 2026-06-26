// Connect sudo overlay — open a privileged sudo session on a server.
//
// Opened with `S` on a selected server (Servers tab). Enter the SpinupWP sudo
// user + its sudo password once; Spinup validates them against the live server and
// then holds them IN MEMORY for the rest of the session (never written to disk),
// so every privileged action on that server (e.g. `K` grant SSH key) just works
// without re-prompting. A connected server shows a green ● on its row; you can
// disconnect here. See docs/2026-06-26_sudo-ssh-key-provisioning-spec.md.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered, Spinner, SecretInput } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"

type Phase = "connected" | "user" | "password" | "verifying" | "error"
type Field = "user" | "password"

export function SudoConnect() {
  const store = useStore()
  const {
    sudoConnectServer: server,
    setSudoConnectServer,
    sudoUserFor,
    isSudoConnected,
    connectSudo,
    disconnectSudo,
    sitesForServer,
    setInputMode,
  } = store

  const connected = server ? isSudoConnected(server.id) : false
  const savedUser = server ? sudoUserFor(server.id) : undefined

  const [phase, setPhase] = useState<Phase>(() => (connected ? "connected" : "user"))
  const [field, setField] = useState<Field>("user")
  const [userInput, setUserInput] = useState(savedUser ?? "")
  const [pwInput, setPwInput] = useState("")
  const [error, setError] = useState<string | null>(null)

  // The credential form owns the keyboard (suppress global shortcuts).
  useEffect(() => {
    setInputMode(phase === "user" || phase === "password")
    return () => setInputMode(false)
  }, [phase, setInputMode])

  const close = () => {
    setInputMode(false)
    setSudoConnectServer(null)
  }

  const submit = () => {
    if (!server) return
    const u = userInput.trim()
    if (!u || !pwInput) return
    setPhase("verifying")
    void connectSudo(server, u, pwInput).then((res) => {
      setPwInput("") // don't keep the secret in component state past the attempt
      if (res.ok) {
        setError(null)
        setPhase("connected")
      } else {
        setError(res.error)
        setPhase("error")
      }
    })
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape") return close()

    if (phase === "connected") {
      if ((name === "x" || name === "d") && server) {
        disconnectSudo(server.id)
        setUserInput(savedUser ?? "")
        setField("password")
        return setPhase("user")
      }
      if (name === "q") return close()
      return
    }

    if (phase === "user" || phase === "password") {
      // ↑/↓ switch fields; the inputs' onSubmit advances/submits.
      if (name === "up") return setField("user")
      if (name === "down") return setField("password")
      return
    }

    if (phase === "error") {
      if (name === "r") {
        setError(null)
        setUserInput(savedUser ?? userInput)
        setField("password")
        return setPhase("password")
      }
      return
    }
  })

  if (!server) return null

  const siteCount = sitesForServer(server.id).length

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
        <text content={connected ? "● " : "○ "} fg={connected ? theme.good : theme.textFaint} style={{ flexShrink: 0 }} />
        <text content="Sudo  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(server.name, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={`${siteCount} site${siteCount === 1 ? "" : "s"}`} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (phase === "connected") {
      return (
        <Panel title=" Sudo connected " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="● Connected as " fg={theme.good} wrapMode="none" />
              <text content={`${savedUser}@${server!.name}`} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Privileged actions on this server run for the rest of this" fg={theme.textDim} wrapMode="none" />
            <text content="session — press K on a site to grant Spinup's SSH key." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="The sudo password is kept in memory only — never saved, and" fg={theme.textFaint} wrapMode="none" />
            <text content="forgotten when you disconnect or quit." fg={theme.textFaint} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="x — disconnect sudo      Esc — close (stays connected)" fg={theme.textDim} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (phase === "verifying") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Checking the sudo connection…" fg={theme.textDim} />
          </box>
        </box>
      )
    }

    if (phase === "error") {
      return (
        <Panel title=" Couldn't connect " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`✕ ${error ?? "Verification failed."}`} fg={theme.bad} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Check the sudo user has your SSH key (key login) and that" fg={theme.textFaint} wrapMode="none" />
            <text content="the sudo password is correct." fg={theme.textFaint} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="r — re-enter the password · Esc — close" fg={theme.textDim} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // user / password form
    return (
      <Panel title=" Connect sudo " active>
        <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="Server  " fg={theme.textDim} wrapMode="none" />
            <text content={server!.name} fg={theme.accent} wrapMode="none" />
          </box>
          <box style={{ height: 1 }} />
          <text content="Why: writing an SSH key into a site user's authorized_keys" fg={theme.textDim} wrapMode="none" />
          <text content="needs root, so Spinup logs in as your sudo user and" fg={theme.textDim} wrapMode="none" />
          <text content="escalates. (The SpinupWP API can't manage SSH keys.)" fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Enter this server's SpinupWP sudo user and its sudo" fg={theme.textDim} wrapMode="none" />
          <text content="password. Held in memory for the session only." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content={(field === "user" ? "❯ " : "  ") + "Sudo user"} fg={field === "user" ? theme.brand : theme.textDim} />
          <input
            focused={field === "user"}
            value={userInput}
            placeholder="e.g. spinup02"
            onInput={setUserInput}
            onSubmit={() => setField("password")}
            style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
          />
          <box style={{ height: 1 }} />
          <text content={(field === "password" ? "❯ " : "  ") + "Sudo password"} fg={field === "password" ? theme.brand : theme.textDim} />
          <SecretInput focused={field === "password"} value={pwInput} placeholder="sudo password" onChange={setPwInput} onSubmit={submit} />
          <box style={{ height: 1 }} />
          <text content="Enter → next field (connects on the password) · ↑↓ switch · Esc cancels" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    if (phase === "connected")
      return [
        { key: "x", label: "disconnect" },
        { key: "esc", label: "close (stays connected)" },
      ]
    if (phase === "error")
      return [
        { key: "r", label: "re-enter" },
        { key: "esc", label: "close" },
      ]
    if (phase === "verifying") return [{ key: "esc", label: "cancel" }]
    return [
      { key: "↑↓", label: "field" },
      { key: "⏎", label: "connect" },
      { key: "esc", label: "cancel" },
    ]
  }
}

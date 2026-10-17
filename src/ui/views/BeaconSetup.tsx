// Beacon setup overlay, opened with ⏎ on Beacon in the Modules tab. The same
// guided flow as `spinuptui beacon setup` (lib/beaconSetup.ts): paste a bot
// token, message the bot so Beacon can find the chat, then a test page — and
// only then is anything saved.

import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { Panel, Centered, Spinner, SecretInput } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { openUrl } from "../../lib/open.ts"
import {
  BOTFATHER_STEPS,
  BOTFATHER_URL,
  botLink,
  channelExists,
  discoverChat,
  saveBeaconChannel,
  sendConnectedMessage,
  setupChannelName,
  verifyBotToken,
  type FoundChat,
} from "../../lib/beaconSetup.ts"

type Phase = "token" | "verifying" | "waiting" | "found" | "saving" | "done" | "error"

const WIDTH = 70

export function BeaconSetup() {
  const { setBeaconSetupOpen, setInputMode } = useStore()
  const [name] = useState(setupChannelName)
  const [replacing] = useState(() => channelExists(name))
  const [phase, setPhase] = useState<Phase>("token")
  const [token, setToken] = useState("")
  const [username, setUsername] = useState("")
  const [chat, setChat] = useState<FoundChat | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retryFrom, setRetryFrom] = useState<Phase>("token")
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    setInputMode(phase === "token")
    return () => setInputMode(false)
  }, [phase, setInputMode])

  // Stop any long-poll when the overlay goes away.
  useEffect(() => () => abort.current?.abort(), [])

  const close = () => {
    abort.current?.abort()
    setInputMode(false)
    setBeaconSetupOpen(false)
  }

  const fail = (message: string, from: Phase) => {
    setError(message)
    setRetryFrom(from)
    setPhase("error")
  }

  const listen = (tok: string) => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setChat(null)
    setPhase("waiting")
    void discoverChat(tok, { signal: ctrl.signal }).then((r) => {
      if (ctrl.signal.aborted) return
      if (r.ok) {
        setChat(r.chat)
        setPhase("found")
      } else fail(r.message, "waiting")
    })
  }

  const submitToken = () => {
    const tok = token.trim()
    if (!tok) return
    setPhase("verifying")
    void verifyBotToken(tok).then((me) => {
      if (!me.ok) return fail(me.error ?? "Telegram rejected the token.", "token")
      setUsername(me.username ?? "")
      listen(tok)
    })
  }

  const save = () => {
    if (!chat) return
    const channel = { type: "telegram" as const, botToken: token.trim(), chatId: chat.chatId }
    setPhase("saving")
    void sendConnectedMessage(name, channel).then(async (r) => {
      if (!r.ok) return fail(`Couldn't send the test message: ${r.message}. Nothing was saved.`, "found")
      await saveBeaconChannel(name, channel, false)
      setToken("") // don't keep the secret in component state once it's saved
      setPhase("done")
    })
  }

  useKeyboard((key) => {
    const k = key.name ?? ""
    if (k === "escape") return close()
    if (phase === "token") return // SecretInput owns typing; Enter submits
    if (phase === "waiting") {
      if (k === "o" && username) return openUrl(botLink(username))
      return
    }
    if (phase === "found") {
      if (k === "return") return save()
      if (k === "r") return listen(token.trim())
      return
    }
    if (phase === "error") {
      if (k === "r") {
        setError(null)
        if (retryFrom === "waiting") return listen(token.trim())
        if (retryFrom === "found" && chat) return setPhase("found")
        setToken("") // a rejected token is replaced, not edited
        return setPhase("token")
      }
      if (k === "q") return close()
      return
    }
    if (phase === "done" && (k === "return" || k === "q")) return close()
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
        zIndex: 200,
      }}
    >
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1 }}>
        <text content="Beacon  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content="connect a Telegram pager" fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={`channel “${name}”`} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>
      <Centered>{body()}</Centered>
      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function body() {
    if (phase === "token") {
      return (
        <Panel title=" 1 · Your bot " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <text content="Beacon pages you through your own Telegram bot. Making one is free:" fg={theme.textDim} />
            <box style={{ height: 1 }} />
            {BOTFATHER_STEPS.map((s, i) => (
              <text key={i} content={`  ${i + 1}. ${s}`} fg={theme.text} />
            ))}
            <box style={{ height: 1 }} />
            <text content="Then paste the token here (it's hidden as you type):" fg={theme.textDim} />
            <SecretInput focused value={token} placeholder="123456789:AAE…" onChange={setToken} onSubmit={submitToken} width={WIDTH - 2} />
            {replacing && (
              <>
                <box style={{ height: 1 }} />
                <text content={`⚠ This replaces the existing “${name}” channel once the new one is tested.`} fg={theme.warn} />
              </>
            )}
            <box style={{ height: 1 }} />
            <text content={`⏎ continue · Esc cancel · BotFather: ${BOTFATHER_URL}`} fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (phase === "verifying" || phase === "saving") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content={phase === "verifying" ? "  Checking the token with Telegram…" : "  Sending a test message…"} fg={theme.textDim} />
        </box>
      )
    }

    if (phase === "waiting") {
      return (
        <Panel title=" 2 · Say hello to your bot " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ Bot " fg={theme.good} wrapMode="none" />
              <text content={username ? `@${username}` : "found"} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Now open Telegram and send your bot any message, so Beacon knows which" fg={theme.text} />
            <text content="chat to page." fg={theme.text} />
            {username && <text content={`  ${botLink(username)}   (press o to open it)`} fg={theme.accent} wrapMode="none" />}
            <box style={{ height: 1 }} />
            <text content="To page a group instead, add the bot to the group and send /start there." fg={theme.textFaint} />
            <box style={{ height: 1 }} />
            <box style={{ flexDirection: "row" }}>
              <Spinner />
              <text content="  Waiting for your message (up to 5 minutes)…" fg={theme.textDim} />
            </box>
          </box>
        </Panel>
      )
    }

    if (phase === "found" && chat) {
      return (
        <Panel title=" 3 · Confirm the chat " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ Message received from " fg={theme.good} wrapMode="none" />
              <text content={chat.label} fg={theme.accent} wrapMode="none" style={{ flexShrink: 1 }} />
            </box>
            <text content={`  a ${chat.kind} chat`} fg={theme.textFaint} />
            <box style={{ height: 1 }} />
            <text content="Beacon will page this chat. Press ⏎ to send a test message and save." fg={theme.text} />
            <text content="Wrong chat? Press r, then message the bot from the right one." fg={theme.textDim} />
          </box>
        </Panel>
      )
    }

    if (phase === "done") {
      return (
        <Panel title=" Beacon connected " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`● Channel “${name}” is set up, and a test message is on its way.`} fg={theme.good} />
            <box style={{ height: 1 }} />
            <text content="Anything on this machine can page you now:" fg={theme.textDim} />
            <text content={`  spinuptui beacon send "web1 is down"`} fg={theme.accent} wrapMode="none" />
            <text content={`  some-report | spinuptui beacon send --silent`} fg={theme.accent} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="⏎ done" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    return (
      <Panel title=" Not connected yet " active>
        <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${error ?? "Something went wrong."}`} fg={theme.bad} />
          <box style={{ height: 1 }} />
          <text content="Nothing was saved. r — try again · Esc — close" fg={theme.textDim} />
        </box>
      </Panel>
    )
  }

  function hints() {
    if (phase === "token") return [{ key: "⏎", label: "continue" }, { key: "esc", label: "cancel" }]
    if (phase === "waiting")
      return [...(username ? [{ key: "o", label: "open the bot" }] : []), { key: "esc", label: "cancel" }]
    if (phase === "found")
      return [
        { key: "⏎", label: "test & save" },
        { key: "r", label: "different chat" },
        { key: "esc", label: "cancel" },
      ]
    if (phase === "error") return [{ key: "r", label: "try again" }, { key: "esc", label: "close" }]
    if (phase === "done") return [{ key: "⏎", label: "done" }]
    return [{ key: "esc", label: "cancel" }]
  }
}

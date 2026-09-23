// Accounts overlay (`A`, from anywhere): the SpinupWP accounts this machine
// knows, which one is active, and switching between them — deliberately one
// account at a time, never a merged fleet, so an action can't land on the wrong
// client's server. Also adds (token validated live, like onboarding), renames,
// and removes accounts. See config.ts "Accounts" for storage and ui/accounts.tsx
// for how a switch remounts the app.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered, Spinner, SecretInput } from "../components.tsx"
import { StatusBar, type KeyHint } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { useAccounts } from "../accounts.tsx"
import { SpinupWPClient } from "../../api/client.ts"
import { deleteSudoPassword } from "../../lib/keychain.ts"
import {
  DEFAULT_BASE_URL,
  DEFAULT_PROFILE,
  PROFILE_CACHE_FILES,
  addProfile,
  listProfiles,
  profileDataDir,
  removeProfile,
  renameProfile,
  type ProfileSummary,
} from "../../config.ts"

type Phase =
  | { kind: "list" }
  | { kind: "add-label" }
  | { kind: "add-token" }
  | { kind: "add-slug" }
  | { kind: "validating" }
  | { kind: "added"; id: string; label: string }
  | { kind: "rename"; id: string }
  | { kind: "confirm-remove"; profile: ProfileSummary }
  | { kind: "switching"; label: string }

// A SpinupWP account slug is the team name, lowercased and dashed — a good first
// guess the user can correct ("Acme Agency" → acme-agency).
const slugGuess = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const INPUT_STYLE = { backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }

export function Accounts({ onClose }: { onClose: () => void }) {
  const { profileId, tokenFromEnv, switchBlocker, setInputMode, setProfileLabel } = useStore()
  const { switchAccount } = useAccounts()
  const [profiles, setProfiles] = useState<ProfileSummary[]>(() => listProfiles())
  const [index, setIndex] = useState(() => Math.max(0, profiles.findIndex((p) => p.id === profileId)))
  const [phase, setPhase] = useState<Phase>({ kind: "list" })
  const [message, setMessage] = useState<{ text: string; color: string } | null>(null)
  const [label, setLabel] = useState("")
  const [token, setToken] = useState("")
  const [slug, setSlug] = useState("")

  // The last row is "+ Add an account".
  const rowCount = profiles.length + 1
  const selected = index < profiles.length ? profiles[index] : null
  const typing = phase.kind === "add-label" || phase.kind === "add-token" || phase.kind === "add-slug" || phase.kind === "rename"

  // Text fields own the keyboard (global shortcuts off) while they're focused.
  useEffect(() => {
    setInputMode(typing)
    return () => setInputMode(false)
  }, [typing, setInputMode])

  const reload = () => setProfiles(listProfiles())
  const say = (text: string, color: string = theme.textDim) => setMessage({ text, color })

  async function doSwitch(p: ProfileSummary) {
    if (p.active) return say(`Already on ${p.label}.`)
    if (tokenFromEnv) return say("SPINUPWP_ACCESS_TOKEN is set, which pins the account — unset it to switch.", theme.warn)
    const blocker = switchBlocker()
    if (blocker) return say(blocker, theme.warn)
    setPhase({ kind: "switching", label: p.label })
    // Remounts the whole app on the new account — this overlay goes with it.
    await switchAccount(p.id)
  }

  async function submitToken() {
    const t = token.trim()
    if (!t) return
    setPhase({ kind: "validating" })
    const result = await new SpinupWPClient({ token: t, baseUrl: DEFAULT_BASE_URL }).validateToken()
    if (!result.ok) {
      say(result.reason, theme.bad)
      setPhase({ kind: "add-token" })
      return
    }
    setMessage(null)
    setSlug(slugGuess(label))
    setPhase({ kind: "add-slug" })
  }

  async function finishAdd() {
    const id = await addProfile({ label: label.trim(), token: token.trim(), accountSlug: slug.trim() || undefined })
    reload()
    setIndex(listProfiles().findIndex((p) => p.id === id))
    setToken("")
    setPhase({ kind: "added", id, label: label.trim() })
  }

  // Remove = forget the account on this machine: its profile (token, DNS
  // connections, local-copy links…), its saved sudo passwords, and its caches.
  // Files in local working copies are never touched.
  async function doRemove(p: ProfileSummary) {
    for (const sid of p.keychainServers) await deleteSudoPassword(sid, p.id)
    // The default account's caches sit beside machine-level files in the config
    // dir itself, so only its named files go; any other account owns its folder.
    const dir = profileDataDir(p.id)
    if (p.id === DEFAULT_PROFILE) {
      for (const f of PROFILE_CACHE_FILES) await rm(join(dir, f), { force: true }).catch(() => {})
    } else {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    await removeProfile(p.id)
    reload()
    setIndex(0)
    setPhase({ kind: "list" })
    say(`Removed ${p.label} from this machine.`, theme.good)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    switch (phase.kind) {
      case "list": {
        if (name === "escape" || name === "q") return onClose()
        if (name === "up" || name === "k") return setIndex((i) => (i - 1 + rowCount) % rowCount)
        if (name === "down" || name === "j") return setIndex((i) => (i + 1) % rowCount)
        setMessage(null)
        if (name === "return" || name === "enter") {
          if (!selected) {
            setLabel("")
            setToken("")
            return setPhase({ kind: "add-label" })
          }
          return void doSwitch(selected)
        }
        if (name === "e" && selected) {
          setLabel(selected.label)
          return setPhase({ kind: "rename", id: selected.id })
        }
        if (name === "x" && selected) {
          if (selected.active) return say("That's the account you're on — switch to another before removing it.", theme.warn)
          return setPhase({ kind: "confirm-remove", profile: selected })
        }
        return
      }
      case "add-label":
      case "add-token":
      case "add-slug":
      case "rename":
        if (name === "escape") {
          setMessage(null)
          return setPhase({ kind: "list" })
        }
        return
      case "added":
        if (name === "return" || name === "enter") {
          const p = listProfiles().find((x) => x.id === phase.id)
          if (p) return void doSwitch(p)
        }
        if (name === "escape" || name === "q") return setPhase({ kind: "list" })
        return
      case "confirm-remove":
        if (name === "y") return void doRemove(phase.profile)
        if (name === "escape" || name === "n" || name === "q") return setPhase({ kind: "list" })
        return
    }
  })

  const hints: KeyHint[] =
    phase.kind === "list"
      ? [
          { key: "↑↓/jk", label: "select" },
          ...(selected?.active ? [] : [{ key: "⏎", label: selected ? "switch" : "add" }]),
          ...(selected ? [{ key: "e", label: "rename" }] : []),
          // The active account can't be removed (switch away first), so don't offer it.
          ...(selected && !selected.active ? [{ key: "x", label: "remove" }] : []),
          { key: "esc", label: "close" },
        ]
      : phase.kind === "confirm-remove"
        ? [
            { key: "y", label: "remove" },
            { key: "esc", label: "cancel" },
          ]
        : phase.kind === "added"
          ? [
              { key: "⏎", label: "switch now" },
              { key: "esc", label: "stay here" },
            ]
          : typing
            ? [
                { key: "⏎", label: "next" },
                { key: "esc", label: "cancel" },
              ]
            : []

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="◆ Accounts" fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content="  one SpinupWP account at a time — switching reloads everything" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
      <Centered>{renderBody()}</Centered>
      <StatusBar hints={hints} message={message?.text} messageColor={message?.color} showGlobal={false} />
    </box>
  )

  function rowHelp(): [string, string][] {
    if (!selected) return [["⏎", "add another SpinupWP account"]]
    const name = truncate(selected.label, 24)
    if (selected.active) return [["⏎", "you're on this one"], ["e", "rename it"]]
    return [
      ["⏎", `switch to ${name}`],
      ["e", "rename"],
      ["x", "remove"],
    ]
  }

  function renderBody() {
    switch (phase.kind) {
      case "list":
        return (
          <Panel title=" Accounts " active>
            <box style={{ flexDirection: "column", width: 70, paddingTop: 1, paddingBottom: 1 }}>
              {profiles.map((p, i) => {
                const sel = i === index
                return (
                  <box key={p.id} style={{ flexDirection: "row", height: 1, backgroundColor: sel ? theme.selectedBg : undefined }}>
                    <text content={p.active ? " ● " : "   "} fg={sel ? theme.text : theme.brand} style={{ flexShrink: 0 }} />
                    <text content={truncate(p.label, 36)} fg={sel ? theme.text : p.active ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                    <text content={truncate(p.accountSlug ?? "", 26)} fg={sel ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 0, marginLeft: 1 }} />
                    <text content={p.active ? "  active " : "         "} fg={sel ? theme.text : theme.good} style={{ flexShrink: 0 }} />
                  </box>
                )
              })}
              <box style={{ flexDirection: "row", height: 1, backgroundColor: index === profiles.length ? theme.selectedBg : undefined }}>
                <text content=" + Add an account" fg={index === profiles.length ? theme.text : theme.accent} wrapMode="none" />
              </box>
              <box style={{ height: 1 }} />
              {/* What the keys do to THIS row — the bottom bar lists them, this says what they'll mean. */}
              <box style={{ flexDirection: "row", height: 1 }}>
                {rowHelp().map(([k, what], i) => (
                  <box key={i} style={{ flexDirection: "row", flexShrink: 0 }}>
                    <text content={i ? "   " : ""} />
                    <text content={k} fg={theme.accent} />
                    <text content={` ${what}`} fg={theme.textDim} wrapMode="none" />
                  </box>
                ))}
              </box>
              <box style={{ height: 1 }} />
              <text content="Each account keeps its own token, DNS connections, local copies and" fg={theme.textFaint} wrapMode="none" />
              <text content="saved sudo passwords. The Uptime Kuma login is shared by all of them." fg={theme.textFaint} wrapMode="none" />
            </box>
          </Panel>
        )
      case "add-label":
        return (
          <Panel title=" Add an account · 1 of 3 " active>
            <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
              <text content="A name for this account — shown in the header while you're on it" fg={theme.accent} />
              <input
                focused
                value={label}
                placeholder="e.g. Acme Agency"
                onInput={setLabel}
                onSubmit={() => label.trim() && setPhase({ kind: "add-token" })}
                style={INPUT_STYLE}
              />
            </box>
          </Panel>
        )
      case "add-token":
      case "validating":
        return (
          <Panel title=" Add an account · 2 of 3 " active>
            <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
              <text content={`API token for ${truncate(label.trim(), 40)}`} fg={theme.accent} />
              <text content="SpinupWP → Settings → API Tokens (Read/Write for changes)" fg={theme.textFaint} wrapMode="none" />
              <SecretInput focused={phase.kind === "add-token"} value={token} placeholder="paste the token here…" onChange={setToken} onSubmit={() => void submitToken()} />
              {phase.kind === "validating" && (
                <box style={{ flexDirection: "row", marginTop: 1 }}>
                  <Spinner />
                  <text content="  Checking the token with SpinupWP…" fg={theme.textDim} />
                </box>
              )}
            </box>
          </Panel>
        )
      case "add-slug":
        return (
          <Panel title=" Add an account · 3 of 3 " active>
            <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
              <text content="✓ Token works." fg={theme.good} />
              <box style={{ height: 1 }} />
              <text content="Account slug — the part after spinupwp.app/ in the dashboard URL." fg={theme.accent} wrapMode="none" />
              <text content="Used for w (open in SpinupWP). Leave empty to skip." fg={theme.textFaint} wrapMode="none" />
              <input focused value={slug} placeholder="acme-agency" onInput={setSlug} onSubmit={() => void finishAdd()} style={INPUT_STYLE} />
            </box>
          </Panel>
        )
      case "added":
        return (
          <Panel title=" Account added " active>
            <box style={{ flexDirection: "column", width: 60, paddingTop: 1, paddingBottom: 1 }}>
              <text content={`✓ ${truncate(phase.label, 50)} is ready.`} fg={theme.good} wrapMode="none" />
              <box style={{ height: 1 }} />
              <text content="Press Enter to switch to it now, or Esc to stay where you are." fg={theme.textDim} wrapMode="none" />
            </box>
          </Panel>
        )
      case "rename":
        return (
          <Panel title=" Rename account " active>
            <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
              <text content="Name shown in the header" fg={theme.accent} />
              <input
                focused
                value={label}
                onInput={setLabel}
                onSubmit={() => {
                  const id = phase.id
                  void renameProfile(id, label).then(() => {
                    reload()
                    setPhase({ kind: "list" })
                    if (id === profileId) setProfileLabel(label.trim())
                  })
                }}
                style={INPUT_STYLE}
              />
            </box>
          </Panel>
        )
      case "confirm-remove": {
        const p = phase.profile
        const n = p.keychainServers.length
        return (
          <Panel title=" Remove account? " active>
            <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
              <text content={`Forget ${truncate(p.label, 44)} on this machine:`} fg={theme.text} wrapMode="none" />
              <text content="  · its API token, DNS connections and local-copy links" fg={theme.textDim} wrapMode="none" />
              <text content={`  · ${n} saved sudo password${n === 1 ? "" : "s"} in the Keychain`} fg={theme.textDim} wrapMode="none" />
              <text content="  · its cached app probes and DNS lookups" fg={theme.textDim} wrapMode="none" />
              <box style={{ height: 1 }} />
              <text content="Nothing changes in SpinupWP, and your local working-copy files stay." fg={theme.textFaint} wrapMode="none" />
              <box style={{ height: 1 }} />
              <text content="Press y to remove · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
            </box>
          </Panel>
        )
      }
      case "switching":
        return (
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={`  Switching to ${truncate(phase.label, 40)}…`} fg={theme.textDim} />
          </box>
        )
    }
  }
}

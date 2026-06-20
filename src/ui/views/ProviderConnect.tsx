// DNS provider connect / manage overlay — Phase 2 (access detection, read-only).
//
// Opened with `c` from the DNS inventory on a zone whose host is an API provider
// (Route 53 → AWS, Cloudflare). It's BOTH the connect form and the per-provider
// manager: it lists every credential ("connection") for that provider — because a
// dev has many accounts — and lets you add another, re-verify, or remove one.
//
// Connecting = verify the credential by listing the account's zones; that same
// data drives the inventory's ACCESS column. Verification runs before anything is
// stored, so a bad credential never persists. Secrets live in config.json (0600).
//
// Secret fields (CF token, AWS secret key) use the masked SecretInput; once saved
// a secret is never shown again (the list shows label + zone count + status only).

import { useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate, timeAgo } from "../../lib/format.ts"
import { Panel, SecretInput } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { openUrl, copyToClipboard } from "../../lib/open.ts"
import { apiProviderFor, PROVIDER_REGISTRY, type Connection } from "../../lib/providers.ts"

type Mode = "list" | "add"
type Pane = "connections" | "zones"

export function ProviderConnect() {
  const store = useStore()
  const { connectZoneTarget, setConnectZoneTarget, connectionsFor, providerZones, addConnection, removeConnection, verifyConnectionById, setInputMode } = store

  const target = connectZoneTarget
  const provider = target ? apiProviderFor(target.hostKey) : null
  const descriptor = provider ? PROVIDER_REGISTRY[provider] : null
  const fields = descriptor?.fields ?? []
  const connections: Connection[] = provider ? connectionsFor(provider) : []

  // Jump straight to the add form when there are no connections — unless the
  // provider has a console fallback (GoDaddy), where the list's `a`/`w` choice
  // (add a key vs open the web console) should be visible first.
  const [mode, setMode] = useState<Mode>(connections.length === 0 && !descriptor?.console ? "add" : "list")
  const openConsole = () => {
    if (!descriptor?.console) return
    if (target) copyToClipboard(target.apex)
    openUrl(descriptor.console)
    const label = descriptor.consoleLabel ?? "web console"
    note(target ? `${label} opened · ${target.apex} copied — Login as the client, then paste.` : `${label} opened.`)
  }
  const [sel, setSel] = useState(0)
  const [pane, setPane] = useState<Pane>("connections")
  const [zoneIndex, setZoneIndex] = useState(0)
  const [field, setField] = useState(0) // 0 = label; 1..N = descriptor.fields
  const [label, setLabel] = useState("")
  const [creds, setCreds] = useState<Record<string, string>>({})
  const setCred = (name: string, val: string) => setCreds((c) => ({ ...c, [name]: val }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const { height } = useTerminalDimensions()
  const safeSel = Math.min(sel, Math.max(0, connections.length - 1))
  const selectedConn = connections[safeSel]
  const selectedVerified = selectedConn ? providerZones.get(selectedConn.id) : undefined
  // The selected connection's zones (idea B: the right-pane drill-down).
  const zones = useMemo(
    () => (selectedVerified?.ok ? [...selectedVerified.zones].sort((a, b) => a.apex.localeCompare(b.apex)) : []),
    [selectedVerified],
  )

  // The form owns the keyboard while adding (so typing a token doesn't navigate).
  useEffect(() => {
    setInputMode(mode === "add")
    return () => setInputMode(false)
  }, [mode, setInputMode])

  // Reset the zone scroll when the selected connection changes.
  useEffect(() => {
    setZoneIndex(0)
  }, [safeSel])

  const close = () => {
    setInputMode(false)
    setConnectZoneTarget(null)
  }

  const note = (msg: string) => {
    setFlash(msg)
    setTimeout(() => setFlash(null), 2500)
  }

  const resetForm = () => {
    setLabel("")
    setCreds({})
    setField(0)
    setError(null)
  }

  const submit = async () => {
    if (busy || !provider) return
    setError(null)
    const missing = fields.find((f) => !f.optional && !(creds[f.name] ?? "").trim())
    if (missing) return setError(`${missing.label.replace(/ \(.*\)$/, "")} is required.`)
    setBusy(true)
    const res = await addConnection(provider, label, creds)
    setBusy(false)
    if (res.ok) {
      note(`Connected — ${res.zones.length} zone${res.zones.length === 1 ? "" : "s"}`)
      resetForm()
      setMode("list")
    } else {
      const base = res.error || "Verification failed."
      setError(descriptor?.console ? `${base} — Esc, then w for the ${descriptor.consoleLabel ?? "console"}.` : base)
    }
  }

  const fieldCount = fields.length + 1 // + the label field

  useKeyboard((key) => {
    const raw = key.name ?? ""
    if (busy) return // ignore input while verifying

    if (mode === "add") {
      if (raw === "escape") return connections.length > 0 || descriptor?.console ? (resetForm(), setMode("list")) : close()
      if (raw === "up") return setField((f) => (f - 1 + fieldCount) % fieldCount)
      if (raw === "down") return setField((f) => (f + 1) % fieldCount)
      return
    }

    // list mode — two panes: connections (left) and that account's zones (right)
    switch (raw) {
      case "escape":
        return pane === "zones" ? setPane("connections") : close()
      case "q":
        return close()
      case "up":
      case "k":
        return pane === "zones"
          ? setZoneIndex((i) => moveSelection(i, -1, zones.length))
          : setSel((i) => moveSelection(i, -1, connections.length))
      case "down":
      case "j":
        return pane === "zones"
          ? setZoneIndex((i) => moveSelection(i, 1, zones.length))
          : setSel((i) => moveSelection(i, 1, connections.length))
      case "right":
      case "l":
      case "tab":
        if (pane === "connections" && zones.length > 0) {
          setZoneIndex(0)
          setPane("zones")
        }
        return
      case "left":
        return pane === "zones" ? setPane("connections") : undefined
      case "a":
        if (pane !== "connections") return
        resetForm()
        return setMode("add")
      case "w":
        // Web-console fallback (e.g. GoDaddy without API access).
        if (descriptor?.console) openConsole()
        return
      case "v": {
        if (pane !== "connections") return
        if (selectedConn) {
          verifyConnectionById(selectedConn.id)
          note(`Re-verifying ${selectedConn.label || selectedConn.id}…`)
        }
        return
      }
      case "x": {
        if (pane !== "connections") return
        if (selectedConn && !selectedConn.env) {
          removeConnection(selectedConn.id)
          setSel(0)
          setPane("connections")
          note("Removed connection")
        } else if (selectedConn?.env) {
          note("Env connection — unset the variable to remove")
        }
        return
      }
    }
  })

  if (!target || !provider || !descriptor) return null
  const providerName = descriptor.name

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 230 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content={`🔑 Connect ${providerName}  `} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={`for ${truncate(target.apex, 40)}`} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
        {mode === "list" ? renderList() : renderAdd()}
      </box>

      <StatusBar hints={hints()} message={busy ? "Verifying…" : (flash ?? error ?? undefined)} messageColor={error && !flash ? theme.bad : theme.brand} showGlobal={false} />
    </box>
  )

  function renderList() {
    const zoneTitle = selectedConn
      ? ` Zones · ${truncate(selectedConn.label || selectedConn.id, 18)}${selectedVerified?.ok ? ` (${zones.length})` : ""} `
      : " Zones "
    return (
      <box style={{ flexGrow: 1, flexDirection: "row", gap: 1 }}>
        {/* Left: the provider's connections (accounts) */}
        <Panel title={` ${providerName} connections `} active={pane === "connections"} width={48}>
          <box style={{ flexDirection: "column", flexGrow: 1, paddingTop: 1 }}>
            {descriptor!.accessNote ? (
              <box style={{ flexDirection: "column", marginBottom: 1 }}>
                <text content={descriptor!.accessNote} fg={theme.textDim} />
                <box style={{ height: 1 }} />
              </box>
            ) : null}
            {connections.length === 0 ? (
              <text
                content={descriptor!.console ? `No API key — press a to add one, or w for the ${descriptor!.consoleLabel ?? "web console"}.` : "No connections yet — press a to add one."}
                fg={theme.textFaint}
              />
            ) : (
              connections.map((c, i) => {
                const v = providerZones.get(c.id)
                const selected = i === safeSel
                const status = !v
                  ? "not verified · v"
                  : v.ok
                    ? `${v.zones.length} zone${v.zones.length === 1 ? "" : "s"} · ${timeAgo(new Date(v.verifiedAt).toISOString())}`
                    : `error: ${truncate(v.error ?? "failed", 22)}`
                const statusColor = !v ? theme.textFaint : v.ok ? theme.good : theme.bad
                return (
                  <box key={c.id} style={{ flexDirection: "row", backgroundColor: selected && pane === "connections" ? theme.selectedBg : undefined }}>
                    <text content={selected ? "› " : "  "} fg={theme.brand} style={{ flexShrink: 0 }} />
                    <text content={truncate(c.label || c.id, 16).padEnd(17)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
                    {c.env ? <text content="env " fg={theme.purple} style={{ flexShrink: 0 }} /> : null}
                    <text content={status} fg={selected ? theme.text : statusColor} wrapMode="none" style={{ flexShrink: 1 }} />
                  </box>
                )
              })
            )}
            <box style={{ flexGrow: 1 }} />
            <text content={`a add · v re-verify · x remove · → zones${descriptor!.console ? ` · w ${descriptor!.consoleLabel ?? "console"}` : ""}`} fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>

        {/* Right: the selected connection's zones (idea B drill-down) */}
        <Panel title={zoneTitle} active={pane === "zones"} flexGrow={1}>
          {renderZones()}
        </Panel>
      </box>
    )
  }

  function renderZones() {
    if (!selectedConn) return <text content="—" fg={theme.textFaint} />
    if (!selectedVerified) return <text content="Not verified yet — press v on the connection." fg={theme.textFaint} wrapMode="none" />
    if (!selectedVerified.ok) return <text content={`Verification failed: ${selectedVerified.error ?? "unknown error"}`} fg={theme.bad} wrapMode="none" />
    if (zones.length === 0) return <text content="No DNS zones in this account." fg={theme.textFaint} wrapMode="none" />
    return (
      <List
        items={zones}
        selectedIndex={Math.min(zoneIndex, zones.length - 1)}
        viewportRows={Math.max(3, height - 7)}
        focused={pane === "zones"}
        keyFor={(z) => z.apex}
        renderRow={(z, selected) => {
          const isTarget = z.apex === target!.apex
          return (
            <text
              content={(isTarget ? "● " : "  ") + truncate(z.apex, 48)}
              fg={selected ? theme.text : isTarget ? theme.brand : theme.textDim}
              wrapMode="none"
            />
          )
        }}
      />
    )
  }

  function renderAdd() {
    const fieldFg = (i: number) => (field === i ? theme.accent : theme.textDim)
    const inputStyle = { backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }
    return (
      <Panel title={` Add ${providerName} connection `} active>
        <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
          <text content="Label (optional — defaults to the account name)" fg={fieldFg(0)} />
          <input focused={field === 0} value={label} placeholder="e.g. main account" onInput={setLabel} onSubmit={() => setField(1)} style={inputStyle} />
          <box style={{ height: 1 }} />

          {fields.map((f, j) => {
            const idx = j + 1
            const last = idx === fieldCount - 1
            const onSubmit = last ? submit : () => setField(idx + 1)
            const labelText = f.label + (f.secret ? " (masked)" : "")
            return (
              <box key={f.name} style={{ flexDirection: "column" }}>
                <text content={labelText} fg={fieldFg(idx)} wrapMode="none" />
                {f.secret ? (
                  <SecretInput focused={field === idx} value={creds[f.name] ?? ""} placeholder={f.placeholder} onChange={(v) => setCred(f.name, v)} onSubmit={onSubmit} />
                ) : (
                  <input focused={field === idx} value={creds[f.name] ?? ""} placeholder={f.placeholder} onInput={(v) => setCred(f.name, v)} onSubmit={onSubmit} style={inputStyle} />
                )}
                <box style={{ height: 1 }} />
              </box>
            )
          })}
          <text content={descriptor!.guidance} fg={theme.textFaint} />
        </box>
      </Panel>
    )
  }

  function hints() {
    if (mode === "add")
      return [
        { key: "↑↓", label: "field" },
        { key: "⏎", label: "next / connect" },
        { key: "esc", label: connections.length > 0 ? "back" : "cancel" },
      ]
    if (pane === "zones")
      return [
        { key: "↑↓/jk", label: "scroll zones" },
        { key: "←", label: "back to accounts" },
        { key: "esc", label: "back" },
      ]
    return [
      { key: "↑↓", label: "account" },
      { key: "→", label: "its zones" },
      { key: "a", label: "add" },
      ...(descriptor?.console ? [{ key: "w", label: descriptor.consoleLabel ?? "console" }] : []),
      { key: "v", label: "re-verify" },
      { key: "x", label: "remove" },
      { key: "esc", label: "close" },
    ]
  }
}

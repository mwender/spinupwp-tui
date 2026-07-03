// Uptime Kuma overlay for a site — opened with `m` in the sites pane.
//
// Two jobs in one window, taught in context:
//   1. No Kuma connection yet → a connect form (URL / username / password). The
//      credential is verified by actually logging in before anything persists;
//      the minted JWT is stored so later sessions (and 2FA accounts) log in by
//      token. Env-sourced connections (SPINUP_KUMA_*) skip this form entirely.
//   2. Connected → monitor setup for THIS site. A vanity site (domain = server
//      name) gets the full treatment: healthz monitor, load push monitor + the
//      once-a-minute heartbeat cron, and `R` re-seeds the page first (the upgrade
//      path for pages published before the health-endpoint feature). A regular
//      site gets a homepage monitor (up/down + cert expiry) — we never touch a
//      client site's files.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { Panel, Centered, Field, SecretInput, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"

const FIELDS = ["url", "username", "password"] as const

export function KumaSite() {
  const { kumaSite: site, setKumaSite, kumaConfigured, connectKuma, kumaMonitorFor, kumaOps, startKumaSetup, servers, setInputMode } = useStore()

  const [draft, setDraft] = useState({ url: "", username: "", password: "" })
  const [fieldIdx, setFieldIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectedVersion, setConnectedVersion] = useState<string | null>(null)

  const server = site ? servers.find((s) => s.id === site.server_id) : undefined
  const isVanity = !!site && !!server && server.name === site.domain
  const registered = site ? kumaMonitorFor(site.domain) : null
  const op = site ? kumaOps.get(site.id) : undefined
  const connecting = !kumaConfigured && !connectedVersion

  // While the connect form is up, its inputs own the keyboard (suppresses the
  // global single-key shortcuts); cleared on connect/close.
  useEffect(() => {
    setInputMode(connecting)
    return () => setInputMode(false)
  }, [connecting, setInputMode])

  const close = () => {
    setInputMode(false)
    setKumaSite(null)
  }

  const verify = () => {
    if (busy) return
    if (!draft.url.trim() || !draft.username.trim() || !draft.password) {
      setError("All three fields are needed.")
      return
    }
    setBusy(true)
    setError(null)
    void connectKuma(draft).then((r) => {
      setBusy(false)
      if (r.ok) {
        setConnectedVersion(r.version ?? "connected")
        setInputMode(false)
      } else setError(r.error)
    })
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (connecting) {
      // The focused <input> consumes printable keys; only navigation reaches us.
      if (name === "escape") {
        if (busy) return
        return close()
      }
      if (name === "return") {
        if (busy) return
        if (fieldIdx < FIELDS.length - 1) return setFieldIdx(fieldIdx + 1)
        return verify()
      }
      if (name === "tab" || name === "down") return setFieldIdx((i) => Math.min(i + 1, FIELDS.length - 1))
      if (name === "up") return setFieldIdx((i) => Math.max(i - 1, 0))
      return
    }
    if (name === "a" && site && op?.status !== "running") return startKumaSetup(site)
    if (name === "R" && isVanity && site && op?.status !== "running") return startKumaSetup(site, { reseed: true })
    if (name === "escape" || name === "q") return close()
  })

  if (!site) return null

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 215 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="◉ Uptime Kuma  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={site.domain} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      <Centered>{connecting ? renderConnect() : renderMonitor()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderConnect() {
    return (
      <Panel title=" Connect Uptime Kuma " active>
        <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
          <text content="One-time setup: your Uptime Kuma instance's URL and login." fg={theme.textDim} wrapMode="none" />
          <text content="Verified by logging in before anything is saved (config, 0600)." fg={theme.textFaint} wrapMode="none" />
          <box style={{ height: 1 }} />
          {FIELDS.map((f, i) => (
            <box key={f} style={{ flexDirection: "row" }}>
              <text content={`${i === fieldIdx ? "❯" : " "} ${f.padEnd(9)}`} fg={i === fieldIdx ? theme.brand : theme.textDim} style={{ flexShrink: 0 }} />
              {f === "password" ? (
                <SecretInput focused={i === fieldIdx && !busy} value={draft.password} onChange={(v: string) => setDraft((d) => ({ ...d, password: v }))} onSubmit={verify} />
              ) : (
                <input
                  focused={i === fieldIdx && !busy}
                  value={draft[f]}
                  onInput={(v: string) => setDraft((d) => ({ ...d, [f]: v }))}
                  placeholder={f === "url" ? "https://kuma.example.com" : ""}
                  style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
                />
              )}
            </box>
          ))}
          <box style={{ height: 1 }} />
          {busy ? (
            <box style={{ flexDirection: "row" }}>
              <Spinner />
              <text content="  Logging in…" fg={theme.textDim} wrapMode="none" />
            </box>
          ) : error ? (
            <text content={`✕ ${error}`} fg={theme.bad} wrapMode="none" />
          ) : (
            <text content="⏎ next field / connect · Esc cancel" fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  function renderMonitor() {
    return (
      <Panel title=" Site monitoring " active>
        <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
          {connectedVersion && (
            <>
              <text content={`● Uptime Kuma connected (${connectedVersion}).`} fg={theme.good} wrapMode="none" />
              <box style={{ height: 1 }} />
            </>
          )}
          <Field label="Site" value={site!.domain} />
          <Field label="Kind" value={isVanity ? "vanity page (full server monitoring)" : "site homepage (up/down + cert expiry)"} />
          <Field label="Monitors" value={registered ? `registered${registered.pushId ? " (healthz + load push)" : ""}` : "not registered yet"} />
          <box style={{ height: 1 }} />
          {op?.status === "running" ? (
            <box style={{ flexDirection: "row" }}>
              <Spinner />
              <text content={`  ${op.detail}`} fg={theme.textDim} wrapMode="none" />
            </box>
          ) : op?.status === "error" ? (
            <text content={`✕ ${op.error}`} fg={theme.bad} />
          ) : op?.status === "done" ? (
            <text content={`✓ ${op.detail}`} fg={theme.good} />
          ) : isVanity ? (
            <>
              <text content="a — register monitors (healthz + load push) & install the cron" fg={theme.textDim} wrapMode="none" />
              <text content="R — also re-publish the page first (pages seeded before the" fg={theme.textDim} wrapMode="none" />
              <text content="    health-endpoint feature need this once)" fg={theme.textFaint} wrapMode="none" />
            </>
          ) : (
            <text content="a — register a homepage monitor in Uptime Kuma" fg={theme.textDim} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  function hints() {
    if (connecting) return [{ key: "⏎", label: "next / connect" }, { key: "esc", label: "cancel" }]
    if (op?.status === "running") return [{ key: "esc", label: "background" }]
    const base = [{ key: "a", label: registered ? "repair monitors" : "add monitors" }]
    if (isVanity) base.push({ key: "R", label: "re-seed + monitors" })
    return [...base, { key: "esc", label: "close" }]
  }
}

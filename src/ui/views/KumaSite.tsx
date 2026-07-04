// Site monitoring overlay — opened with `m` in the sites pane.
//
// The monitor screen is the default; the Kuma connect form is opt-in (`c`, or
// pressing `a` while unconnected), so the vanity-page refresh works with no
// Uptime Kuma at all:
//   - `R` on a vanity site (domain = server name) re-publishes the embedded page
//     — the upgrade path for pages seeded by older Spinup versions. Without a
//     Kuma connection that's ALL it does; with one it also registers the healthz
//     + load push monitors and installs the heartbeat cron.
//   - `a` registers monitors for this site (vanity: healthz + load push + cron;
//     regular site: homepage monitor only — client site files are never touched).
//   - `f` (regular sites) calibrates the front-page check: reads the live front
//     page, derives a template fingerprint (body class / canonical — survives
//     copy edits), and registers a Kuma keyword monitor asserting it at a chosen
//     window. Catches "the cache is serving the wrong page" (HTTP stays 200).
//     Re-running recalibrates in place (monitor history survives a redesign).
//   - `r` (vanity, confirm-gated) rotates the monitoring secrets: new push token
//     edited into the existing monitor (history kept), cron rewritten, new health
//     key re-seeded — so secrets shown on a screencast can be killed right after.
//   - The connect form verifies by actually logging in before anything persists;
//     the minted JWT is stored so later sessions (and 2FA accounts) log in by
//     token. Env-sourced connections (SPINUP_KUMA_*) never see the form.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { Panel, Centered, Field, SecretInput, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { isVanityPair } from "../../lib/vanitySite.ts"

const BASE_FIELDS = ["url", "username", "password"] as const
// Fixed input width: the panel body is 66 wide, the label gutter is 12 ("❯ " +
// padEnd(10)), so 52 fills the row — roomy enough that long URLs stay visible.
const INPUT_W = 52

// Check windows for the front-page fingerprint monitor. The check is one GET
// served straight from nginx's page cache (no PHP), so even 5m costs the site
// nothing — the window is really "how long a wrong page may go unnoticed".
const FP_WINDOWS = [
  { label: "5m", sec: 300 },
  { label: "15m", sec: 900 },
  { label: "30m", sec: 1800 },
  { label: "1h", sec: 3600 },
] as const

export function KumaSite() {
  const { kumaSite: site, setKumaSite, kumaConfigured, connectKuma, kumaMonitorFor, kumaOps, startKumaSetup, startVanityReseed, startKumaRotate, startFingerprintSetup, kumaStatus, servers, setInputMode } = useStore()

  const [draft, setDraft] = useState({ url: "", username: "", password: "" })
  const [fieldIdx, setFieldIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectedVersion, setConnectedVersion] = useState<string | null>(null)
  const [showConnect, setShowConnect] = useState(false)
  // `r` arms a confirm (rotation kills the live push URL / health key the moment
  // it fires — never do that on a stray keypress); y/⏎ fires, Esc disarms.
  const [confirmRotate, setConfirmRotate] = useState(false)
  // `f` opens the front-page check-window picker; ⏎ calibrates & registers.
  const [fpPick, setFpPick] = useState(false)
  const [fpIdx, setFpIdx] = useState(0)
  // 2FA: revealed only after Kuma answers `tokenRequired` to a correct password.
  // The code is used once — the stored JWT covers every later login.
  const [needsTwofa, setNeedsTwofa] = useState(false)
  const [twofa, setTwofa] = useState("")
  const fields: string[] = needsTwofa ? [...BASE_FIELDS, "2FA code"] : [...BASE_FIELDS]

  const server = site ? servers.find((s) => s.id === site.server_id) : undefined
  const isVanity = !!site && !!server && isVanityPair(site.domain, server.name)
  const registered = site ? kumaMonitorFor(site.domain) : null
  const op = site ? kumaOps.get(site.id) : undefined
  // Not gated on kumaConfigured: `c` must also work as a RE-connect (e.g. the
  // stored JWT went stale after a Kuma password change on a 2FA account —
  // without this the only fix would be hand-editing config.json).
  const connecting = showConnect

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
      setError("URL, username and password are all needed.")
      return
    }
    if (needsTwofa && !twofa.trim()) {
      setError("Enter the current 6-digit code from your authenticator.")
      return
    }
    setBusy(true)
    setError(null)
    void connectKuma(draft, needsTwofa ? twofa.trim() : undefined).then((r) => {
      setBusy(false)
      if (r.ok) {
        setConnectedVersion(r.version ?? "connected")
        setShowConnect(false)
        setInputMode(false)
        return
      }
      if (r.tokenRequired && !needsTwofa) {
        // Password was right; the account wants a TOTP. Reveal the field and
        // land the cursor on it.
        setNeedsTwofa(true)
        setFieldIdx(BASE_FIELDS.length)
        setError("2FA is on — enter the current code (needed once; a token is stored after).")
        return
      }
      setError(r.error)
    })
  }

  useKeyboard((key) => {
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw
    if (connecting) {
      // The focused <input> consumes printable keys; only navigation reaches us.
      if (name === "escape") {
        if (busy) return
        return setShowConnect(false) // back to the monitor screen, not out
      }
      if (name === "return") {
        if (busy) return
        if (fieldIdx < fields.length - 1) return setFieldIdx(fieldIdx + 1)
        return verify()
      }
      if (name === "tab" || name === "down") return setFieldIdx((i) => Math.min(i + 1, fields.length - 1))
      if (name === "up") return setFieldIdx((i) => Math.max(i - 1, 0))
      return
    }
    if (confirmRotate) {
      if ((name === "y" || name === "return") && site) {
        setConfirmRotate(false)
        return startKumaRotate(site)
      }
      if (name === "escape" || name === "n" || name === "q") return setConfirmRotate(false)
      return
    }
    if (fpPick) {
      if (name === "left" || name === "up" || name === "h" || name === "k") return setFpIdx((i) => Math.max(i - 1, 0))
      if (name === "right" || name === "down" || name === "l" || name === "j" || name === "tab") return setFpIdx((i) => Math.min(i + 1, FP_WINDOWS.length - 1))
      if (/^[1-4]$/.test(name)) return setFpIdx(Number(name) - 1)
      if (name === "return" && site) {
        setFpPick(false)
        return startFingerprintSetup(site, FP_WINDOWS[fpIdx]!.sec)
      }
      if (name === "escape" || name === "q") return setFpPick(false)
      return
    }
    if (name === "c") return setShowConnect(true)
    if (name === "f" && !isVanity && site && op?.status !== "running") {
      if (!kumaConfigured) return setShowConnect(true) // the check lives in Kuma
      // Preselect the stored window on recalibration so ⏎⏎ keeps it.
      const storedSec = registered?.fingerprint?.interval
      const idx = FP_WINDOWS.findIndex((w) => w.sec === storedSec)
      setFpIdx(idx >= 0 ? idx : 0)
      return setFpPick(true)
    }
    if (name === "r" && isVanity && site && op?.status !== "running") return setConfirmRotate(true)
    if (name === "a" && site && op?.status !== "running") {
      if (!kumaConfigured) return setShowConnect(true) // monitors need a connection
      return startKumaSetup(site)
    }
    if (name === "R" && isVanity && site && op?.status !== "running") {
      // Connected: re-publish + monitors + cron. Unconnected: just the page.
      return kumaConfigured ? startKumaSetup(site, { reseed: true }) : startVanityReseed(site)
    }
    if (name === "escape" || name === "q") return close()
  })

  if (!site) return null

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 215 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="◉ Site monitoring  " fg={theme.brand} style={{ flexShrink: 0 }} />
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
          {fields.map((f, i) => (
            <box key={f} style={{ flexDirection: "column" }}>
              <box style={{ flexDirection: "row" }}>
                <text content={`${i === fieldIdx ? "❯" : " "} ${f.padEnd(10)}`} fg={i === fieldIdx ? theme.brand : theme.textDim} style={{ flexShrink: 0 }} />
                {f === "password" ? (
                  <SecretInput focused={i === fieldIdx && !busy} value={draft.password} onChange={(v: string) => setDraft((d) => ({ ...d, password: v }))} onSubmit={verify} width={INPUT_W} />
                ) : f === "2FA code" ? (
                  <input
                    focused={i === fieldIdx && !busy}
                    value={twofa}
                    onInput={setTwofa}
                    placeholder="123456"
                    style={{ width: INPUT_W, backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
                  />
                ) : (
                  <input
                    focused={i === fieldIdx && !busy}
                    value={draft[f as "url" | "username"]}
                    onInput={(v: string) => setDraft((d) => ({ ...d, [f]: v }))}
                    placeholder={f === "url" ? "https://kuma.example.com" : ""}
                    style={{ width: INPUT_W, backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
                  />
                )}
              </box>
              {i < fields.length - 1 && <box style={{ height: 1 }} />}
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
            <text content="⏎ next field / connect · Esc back" fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  function renderMonitor() {
    const fp = registered?.fingerprint
    const fpUp = site ? (kumaStatus.get(site.domain)?.fingerprintUp ?? null) : null
    const win = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.round(sec / 60)}m`)
    const fpValue = fp
      ? `${fp.detail} · every ${win(fp.interval)}${fpUp === false ? " · WRONG PAGE SERVED" : fpUp === true ? " · ok" : ""}`
      : registered?.fingerprintId
        ? "registered (details unknown) · f recalibrates"
        : "not calibrated · f"
    const fpColor = fpUp === false ? theme.bad : fp ? (fpUp === true ? theme.good : theme.text) : theme.textFaint
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
          <Field label="Kuma" value={kumaConfigured ? "connected · c to reconnect" : "not connected · c"} valueColor={kumaConfigured ? theme.good : theme.textFaint} />
          <Field
            label="Monitors"
            value={
              registered?.healthId
                ? `registered${registered.pushId ? " (healthz + load push)" : ""}`
                : registered?.fingerprintId
                  ? "front-page check only · a adds the up/down monitor"
                  : "not registered yet"
            }
          />
          {!isVanity && <Field label="Front page" value={fpValue} valueColor={fpColor} />}
          <box style={{ height: 1 }} />
          {fpPick ? (
            <>
              <text content="Front-page check — alerts when the wrong page is served." fg={theme.text} wrapMode="none" />
              <text content="Reads the live page now (while it's healthy), derives a template" fg={theme.textDim} wrapMode="none" />
              <text content="fingerprint (body class / canonical — survives copy edits), and" fg={theme.textDim} wrapMode="none" />
              <text content="registers a Kuma keyword monitor asserting it." fg={theme.textDim} wrapMode="none" />
              <box style={{ height: 1 }} />
              <box style={{ flexDirection: "row" }}>
                <text content="Check window:" fg={theme.textDim} style={{ flexShrink: 0 }} />
                {FP_WINDOWS.map((w, i) => (
                  <text key={w.label} content={i === fpIdx ? `  ▸${w.label}` : `   ${w.label}`} fg={i === fpIdx ? theme.brand : theme.textFaint} style={{ flexShrink: 0 }} />
                ))}
              </box>
              <box style={{ height: 1 }} />
              <text content="←/→ or 1-4 window · ⏎ calibrate & register · esc cancel" fg={theme.textFaint} wrapMode="none" />
            </>
          ) : confirmRotate ? (
            <>
              <text content="Rotate this site's monitoring secrets?" fg={theme.warn} wrapMode="none" />
              <text content="A new push URL and health key are minted; the old ones stop" fg={theme.textDim} wrapMode="none" />
              <text content="working immediately. Kuma monitor history is kept." fg={theme.textDim} wrapMode="none" />
              <box style={{ height: 1 }} />
              <text content="y / ⏎ rotate · esc cancel" fg={theme.textFaint} wrapMode="none" />
            </>
          ) : op?.status === "running" ? (
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
              <text
                content={kumaConfigured ? "R — re-publish the page, register monitors & install the cron" : "R — re-publish the page (current version, health endpoints)"}
                fg={theme.textDim}
                wrapMode="none"
              />
              <text
                content={kumaConfigured ? "a — register monitors & cron without touching the page" : "a — register Kuma monitors (connects Uptime Kuma first)"}
                fg={theme.textDim}
                wrapMode="none"
              />
              <text content="r — rotate secrets: new push URL + health key (old ones die)" fg={theme.textDim} wrapMode="none" />
            </>
          ) : (
            <>
              <text content={kumaConfigured ? "a — register a homepage monitor in Uptime Kuma" : "a — register a homepage monitor (connects Uptime Kuma first)"} fg={theme.textDim} wrapMode="none" />
              <text
                content={registered?.fingerprintId ? "f — recalibrate the front-page check (e.g. after a redesign)" : "f — front-page check: alert when the wrong page is served"}
                fg={theme.textDim}
                wrapMode="none"
              />
            </>
          )}
        </box>
      </Panel>
    )
  }

  function hints() {
    if (connecting) return [{ key: "⏎", label: "next / connect" }, { key: "esc", label: "back" }]
    if (confirmRotate) return [{ key: "y/⏎", label: "rotate" }, { key: "esc", label: "cancel" }]
    if (fpPick) return [{ key: "←/→", label: "window" }, { key: "⏎", label: "calibrate" }, { key: "esc", label: "cancel" }]
    if (op?.status === "running") return [{ key: "esc", label: "background" }]
    const base: { key: string; label: string }[] = []
    if (isVanity) base.push({ key: "R", label: kumaConfigured ? "refresh page + monitors" : "refresh page" })
    if (isVanity) base.push({ key: "r", label: "rotate secrets" })
    base.push({ key: "a", label: registered ? "repair monitors" : "add monitors" })
    if (!isVanity) base.push({ key: "f", label: registered?.fingerprintId ? "recalibrate front page" : "front-page check" })
    base.push({ key: "c", label: kumaConfigured ? "reconnect Kuma" : "connect Kuma" })
    return [...base, { key: "esc", label: "close" }]
  }
}

// Site monitoring overlay — opened with `m` in the sites pane.
//
// Full-screen two-pane browser (mirrors ProviderConnect.tsx): a left list of
// this site's monitor kinds (source: MONITOR_GLOSSARY, filtered by vanity vs
// regular) with a status dot, and a right detail pane showing whichever one
// is highlighted — its one-liner, longer mechanism description, live status,
// and how to act on it. The Kuma connect form is opt-in (`c`, or pressing
// `a` while unconnected), so the vanity-page refresh works with no Uptime
// Kuma at all:
//   - `↑↓`/`jk` move the highlight in the left list.
//   - `a` acts on WHICHEVER monitor is currently selected — one key, not one
//     per kind. Front page selected → opens the calibration window picker;
//     Cache bypass selected → opens its window picker; anything else →
//     register/repair (vanity: healthz + load push + cron + Redis/PHP-fatal
//     sentinels if sudo is connected; regular site: homepage monitor only —
//     client site files are never touched).
//   - `R` on a vanity site (domain = server name) re-publishes the embedded
//     page — the upgrade path for pages seeded by older Spinup versions.
//     Without a Kuma connection that's ALL it does; with one it also
//     registers monitors and installs the heartbeat cron.
//   - `n` (alerts) lists Kuma's notification providers by name (Telegram, email,
//     …) and toggles them per site across all of the site's Spinup monitors —
//     detection is real (providers ride the post-login event burst), only the
//     provider's own setup (bot token etc.) stays in Kuma's settings.
//   - `r` (vanity, confirm-gated) rotates the monitoring secrets: new push token
//     edited into the existing monitor (history kept), cron rewritten, new health
//     key re-seeded — so secrets shown on a screencast can be killed right after.
//   - `d` (regular sites) runs the doctor — a pure-HTTP cache-vs-fresh-render
//     diagnosis, deliberately not gated on a Kuma connection.
//   - The connect form verifies by actually logging in before anything persists;
//     the minted JWT is stored so later sessions (and 2FA accounts) log in by
//     token. Env-sourced connections (SPINUP_KUMA_*) never see the form.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme, statusDot, statusColor } from "../../lib/theme.ts"
import { Panel, Centered, Field, SecretInput, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, type KumaAlertProvider } from "../store.tsx"
import { isVanityPair } from "../../lib/vanitySite.ts"
import { openUrl } from "../../lib/open.ts"
import { runSiteDoctor, type DoctorReport } from "../../lib/siteDoctor.ts"
import { classifyStack } from "../../lib/stack.ts"

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

// Check windows for the cache-bypass monitor. Unlike the fingerprint check
// (served from cache, costs nothing), this forces a real PHP render every
// time — the window is really "how much added load is acceptable", so it
// skews much longer. Defaults to 1h.
const BYPASS_WINDOWS = [
  { label: "30m", sec: 1800 },
  { label: "1h", sec: 3600 },
  { label: "2h", sec: 7200 },
  { label: "4h", sec: 14400 },
  { label: "6h", sec: 21600 },
] as const
const BYPASS_DEFAULT_IDX = 1 // "1h"

// The `i` glossary overlay's content — one entry per monitor kind this view
// can register, accurate to the actual mechanism (not an approximation of
// it). `contexts` gates which site kind sees each entry.
interface GlossaryEntry {
  key: string
  label: string
  tagline: string
  detail: string
  contexts: Array<"vanity" | "regular">
}
const MONITOR_GLOSSARY: GlossaryEntry[] = [
  {
    key: "health-site",
    label: "Site health check",
    tagline: "Is this specific website up right now?",
    detail:
      "A plain HTTP check on this site's own homepage, plus certificate-expiry alerting. Served straight from the page cache when one exists — cheap, but for that exact reason it can't see a PHP fatal hiding behind a still-warm cache. This is about whether THIS site answers — independent of whether the server it lives on is under strain.",
    contexts: ["regular"],
  },
  {
    key: "health-server",
    label: "Server health check",
    tagline: "Is the server itself under strain?",
    detail:
      "Hits the vanity page's /?healthz endpoint — a small script that reports the server's own resource state (load, disk) and returns 503 when it's strained. This is about the server's health, not any one site's: a customer site can be completely broken while this stays green, and the server can be strained while every site still limps out a 200.",
    contexts: ["vanity"],
  },
  {
    key: "push",
    label: "Load heartbeat",
    tagline: "Is the server itself still alive?",
    detail:
      "A once-a-minute cron on the server pushes its 1-minute load average to Kuma. It's a dead-man's-switch: the cron never reports \"down\" itself — it just goes silent if the server, the cron, or its network egress dies, and Kuma's own missed-heartbeat timeout is what raises the alarm.",
    contexts: ["vanity"],
  },
  {
    key: "redis",
    label: "Redis sentinel",
    tagline: "Is Redis actually answering?",
    detail:
      "The same heartbeat cron also runs redis-cli ping every minute and actively reports up/down. Unlike the load heartbeat, this alerts immediately when Redis stops answering while the server itself is fine — important because SpinupWP's default object-cache drop-in makes a dead Redis fatal on every page-cache miss.",
    contexts: ["vanity"],
  },
  {
    key: "fatal",
    label: "PHP-fatal sentinel",
    tagline: "Did any site on this server just start fataling?",
    detail:
      "A root-level cron scans every site's error/debug logs each minute for new \"PHP Fatal error\" lines. Catches the exact blind spot where a fatal happens behind a still-warm page cache and the plain per-site checks never notice. One monitor per server (not per site) to avoid pileup — the specific affected domain is named in the down alert's own message.",
    contexts: ["vanity"],
  },
  {
    key: "fingerprint",
    label: "Front page",
    tagline: "Is the cache serving the right page?",
    detail:
      "At setup time, reads the live homepage and derives a template-identity fingerprint from whatever's actually there — a body-class token if one exists, otherwise the canonical link tag. From then on it asserts that same fingerprint stays present. Reads straight from the page cache, so it catches the cache serving a stale or wrong template even though the page still answers 200 — a failure a plain up/down check can't see.",
    contexts: ["regular"],
  },
  {
    key: "bypass",
    label: "Cache bypass",
    tagline: "Can PHP actually render this page right now?",
    detail:
      "The same homepage URL, but with a Cookie: wordpress_no_cache=1 header that forces the page cache to be skipped — so unlike the checks above, this one genuinely exercises PHP on every check. That's also why it costs the site something (a full render each time) and is opt-in rather than automatic, meant for sites with an actual history of PHP fatals hiding behind the cache.",
    contexts: ["regular"],
  },
]

// The `n` (alerts) step's state machine: load → list providers → toggle.
type AlertsState =
  | null
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; providers: KumaAlertProvider[]; monitorIds: number[]; idx: number; busy: boolean; flash: string | null }

// A passive, header-line summary of alert wiring — fetched once when the
// overlay opens (not polled), kept in sync with `n`'s own toggles. Separate
// from AlertsState since it must survive after `n`'s interactive view closes.
type AlertSummary = null | { kind: "loading" } | { kind: "error"; error: string } | { kind: "ready"; providers: KumaAlertProvider[] }

export function KumaSite() {
  const { kumaSite: site, setKumaSite, kumaConfigured, kumaUrl, connectKuma, kumaMonitorFor, kumaOps, startKumaSetup, startVanityReseed, startKumaRotate, startFingerprintSetup, startBypassMonitorSetup, removeSiteMonitor, fetchKumaAlerts, toggleKumaAlert, clearKumaOp, kumaStatus, servers, setInputMode } = useStore()

  const [draft, setDraft] = useState({ url: "", username: "", password: "" })
  const [fieldIdx, setFieldIdx] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectedVersion, setConnectedVersion] = useState<string | null>(null)
  const [showConnect, setShowConnect] = useState(false)
  // `r` arms a confirm (rotation kills the live push URL / health key the moment
  // it fires — never do that on a stray keypress); y/⏎ fires, Esc disarms.
  const [confirmRotate, setConfirmRotate] = useState(false)
  // `x` arms a confirm before deleting an opt-in monitor (front page / cache
  // bypass) — remembers WHICH kind, unlike confirmRotate (only one target).
  const [confirmRemove, setConfirmRemove] = useState<"fingerprint" | "bypass" | null>(null)
  // `f` opens the front-page check-window picker; ⏎ calibrates & registers.
  const [fpPick, setFpPick] = useState(false)
  const [fpIdx, setFpIdx] = useState(0)
  // `b` opens the cache-bypass check-window picker; ⏎ registers/recalibrates.
  // Own state (not shared with fpPick) — different window array and default.
  const [bypassPick, setBypassPick] = useState(false)
  const [bypassIdx, setBypassIdx] = useState(BYPASS_DEFAULT_IDX)
  // `n` opens the alerts step — a live read of Kuma's notification providers and
  // which are attached to this site's monitors; ⏎ toggles the selected one.
  const [alerts, setAlerts] = useState<AlertsState>(null)
  // Passive header-line summary of alert wiring — fetched once per site open
  // (see the effect below), not polled; kept in sync with `n`'s own toggles.
  const [alertSummary, setAlertSummary] = useState<AlertSummary>(null)
  // Which monitor kind is highlighted in the left-hand list (full-screen
  // browser). Clamped against `entries.length` at read time, not here — the
  // list's length depends on isVanity, computed after this point.
  const [selectedIdx, setSelectedIdx] = useState(0)
  // `d` runs the doctor — read-only HTTP diagnosis (works without Kuma).
  const [doctor, setDoctor] = useState<null | { kind: "loading" } | { kind: "ready"; report: DoctorReport }>(null)
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

  // The left-hand list's rows for this site's context, and the currently
  // highlighted one — clamped so a stale index (e.g. from a previous site
  // with more rows) never indexes past the end.
  const entries = MONITOR_GLOSSARY.filter((e) => e.contexts.includes(isVanity ? "vanity" : "regular"))
  const safeIdx = Math.min(selectedIdx, Math.max(entries.length - 1, 0))
  const selected = entries[safeIdx]

  const win = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.round(sec / 60)}m`)
  const healthUp = site ? (kumaStatus.get(site.domain)?.up ?? null) : null
  const fpUp = site ? (kumaStatus.get(site.domain)?.fingerprintUp ?? null) : null
  const redisUp = site ? (kumaStatus.get(site.domain)?.redisUp ?? null) : null
  const fatalUp = site ? (kumaStatus.get(site.domain)?.fatalUp ?? null) : null
  const bypassUp = site ? (kumaStatus.get(site.domain)?.bypassUp ?? null) : null
  const fp = registered?.fingerprint
  const fpValue = fp
    ? `${fp.detail} · every ${win(fp.interval)}${fpUp === false ? " · WRONG PAGE SERVED" : fpUp === true ? " · ok" : ""}`
    : registered?.fingerprintId
      ? "registered (details unknown) · a recalibrates"
      : "not calibrated · a"
  const fpColor = fpUp === false ? theme.bad : fp ? (fpUp === true ? theme.good : theme.text) : theme.textFaint
  const redisValue = !registered?.redisId
    ? "not registered · a adds it"
    : redisUp === false
      ? "down"
      : redisUp === true
        ? "up"
        : "registered (status unknown)"
  const redisColor = redisUp === false ? theme.bad : registered?.redisId ? (redisUp === true ? theme.good : theme.text) : theme.textFaint
  const fatalValue = !registered?.fatalId
    ? "not registered · a adds it"
    : fatalUp === false
      ? "down"
      : fatalUp === true
        ? "up"
        : "registered (status unknown)"
  const fatalColor = fatalUp === false ? theme.bad : registered?.fatalId ? (fatalUp === true ? theme.good : theme.text) : theme.textFaint
  const bypassValue = !registered?.bypassId
    ? "not registered"
    : bypassUp === false
      ? "down · a recalibrates"
      : bypassUp === true
        ? "up · a recalibrates"
        : "registered (status unknown) · a recalibrates"
  const bypassColor = bypassUp === false ? theme.bad : registered?.bypassId ? (bypassUp === true ? theme.good : theme.text) : theme.textFaint

  // Per-entry status, normalized into the { registered, upState } shape
  // statusDot/statusColor's connection-style vocabulary maps onto (neither
  // accepts "up"/"down" directly — see theme.ts).
  function statusFor(key: string): { registered: boolean; upState: boolean | null; value: string; color: string } {
    switch (key) {
      case "health-site":
      case "health-server":
        return {
          registered: !!registered?.healthId,
          upState: healthUp,
          value: !registered?.healthId
            ? registered?.fingerprintId
              ? "front-page check only"
              : "not registered"
            : healthUp === false
              ? "down"
              : healthUp === true
                ? "up"
                : "registered (status unknown)",
          color: healthUp === false ? theme.bad : registered?.healthId ? (healthUp === true ? theme.good : theme.text) : theme.textFaint,
        }
      case "push":
        // The load-heartbeat cron feeds the SAME shared `up` field as the
        // health check (store.tsx's poll loop only sets it from push when
        // health hasn't already) — there's no independent push-only signal.
        return {
          registered: !!registered?.pushId,
          upState: healthUp,
          value: !registered?.pushId ? "not registered" : healthUp === false ? "down" : healthUp === true ? "up" : "registered (status unknown)",
          color: healthUp === false ? theme.bad : registered?.pushId ? (healthUp === true ? theme.good : theme.text) : theme.textFaint,
        }
      case "redis":
        return { registered: !!registered?.redisId, upState: redisUp, value: redisValue, color: redisColor }
      case "fatal":
        return { registered: !!registered?.fatalId, upState: fatalUp, value: fatalValue, color: fatalColor }
      case "fingerprint":
        return { registered: !!registered?.fingerprintId, upState: fpUp, value: fpValue, color: fpColor }
      case "bypass":
        return { registered: !!registered?.bypassId, upState: bypassUp, value: bypassValue, color: bypassColor }
      default:
        return { registered: false, upState: null, value: "unknown", color: theme.textFaint }
    }
  }
  // statusDot/statusColor's own vocabulary (theme.ts:26-47) is connection/
  // deploy-style strings, not up/down — normalize here rather than there.
  function dotStatus(s: { registered: boolean; upState: boolean | null }): string | null {
    if (!s.registered) return null
    if (s.upState === true) return "active"
    if (s.upState === false) return "failed"
    return "pending"
  }
  // The specific Kuma monitor id behind an entry, for the `o` deep-link — null
  // when not yet registered (nothing to link to).
  function monitorIdFor(key: string): number | null {
    switch (key) {
      case "health-site":
      case "health-server":
        return registered?.healthId ?? null
      case "push":
        return registered?.pushId ?? null
      case "redis":
        return registered?.redisId ?? null
      case "fatal":
        return registered?.fatalId ?? null
      case "fingerprint":
        return registered?.fingerprintId ?? null
      case "bypass":
        return registered?.bypassId ?? null
      default:
        return null
    }
  }

  // Compresses alertSummary into one header line. Only flags the ABNORMAL
  // case explicitly (partial wiring) — full wiring is the expected state and
  // doesn't need its own callout.
  function formatAlertSummary(): { text: string; color: string } {
    if (!kumaConfigured) return { text: "Alerts: connect Kuma first · c", color: theme.textFaint }
    if (!alertSummary || alertSummary.kind === "loading") return { text: "Alerts: checking…", color: theme.textFaint }
    if (alertSummary.kind === "error") return { text: "Alerts: unavailable · n to retry", color: theme.textFaint }
    if (alertSummary.providers.length === 0) return { text: "Alerts: none configured in Kuma · n to add one", color: theme.textFaint }
    const attached = alertSummary.providers.filter((p) => p.attachedAny)
    if (attached.length === 0) return { text: "Alerts: not wired to any provider · n to choose", color: theme.warn }
    const names = attached.map((p) => p.name).join(", ")
    const anyPartial = attached.some((p) => p.attachedAny && !p.attachedAll)
    return { text: `Alerts: ${names}${anyPartial ? " (some monitors only)" : ""} · n to manage`, color: theme.good }
  }

  // While the connect form is up, its inputs own the keyboard (suppresses the
  // global single-key shortcuts); cleared on connect/close.
  useEffect(() => {
    setInputMode(connecting)
    return () => setInputMode(false)
  }, [connecting, setInputMode])

  // Silently fetch alert-wiring status once per site open (not polled — this
  // needs a getMonitor round-trip per monitor, unlike the passive poll loop's
  // beat reads, so it isn't "free" the way up/down status is). Re-fires on a
  // genuinely different site (site?.domain toggles through undefined when the
  // overlay closes, so reopening the same site re-fetches too).
  useEffect(() => {
    if (!site || !kumaConfigured) {
      setAlertSummary(null)
      return
    }
    let cancelled = false
    setAlertSummary({ kind: "loading" })
    void fetchKumaAlerts(site).then((r) => {
      if (cancelled) return
      setAlertSummary(r.ok ? { kind: "ready", providers: r.providers } : { kind: "error", error: r.error })
    })
    return () => {
      cancelled = true
    }
  }, [site?.domain, kumaConfigured, fetchKumaAlerts])

  const runDoctor = () => {
    if (!site) return
    setDoctor({ kind: "loading" })
    const proto = site.https?.enabled ? "https" : "http"
    void runSiteDoctor({
      url: `${proto}://${site.domain}/`,
      expectedKeyword: registered?.fingerprint?.keyword ?? null,
      pageCacheEnabled: site.page_cache?.enabled ?? null,
      sshTarget: site.site_user && server ? `${site.site_user}@${server.name}` : null,
      isWordPress: !!site.is_wordpress,
      // Bedrock relocates the login under /wp/ — aim the door probe there.
      loginPath: classifyStack(site) === "Bedrock" ? "/wp/wp-login.php" : "/wp-login.php",
    }).then((report) => setDoctor((prev) => (prev ? { kind: "ready", report } : prev)))
  }

  const close = () => {
    // A settled result was seen — forget it so the overlay opens fresh next
    // time (a RUNNING op stays: esc deliberately backgrounds it).
    if (site && op && op.status !== "running") clearKumaOp(site.id)
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
    if (confirmRemove) {
      if ((name === "y" || name === "return") && site) {
        const kind = confirmRemove
        setConfirmRemove(null)
        return removeSiteMonitor(site, kind)
      }
      if (name === "escape" || name === "n" || name === "q") return setConfirmRemove(null)
      return
    }
    if (doctor) {
      if (name === "escape" || name === "q") return setDoctor(null)
      if (doctor.kind !== "ready") return
      if (name === "d") return runDoctor()
      if (name === "f" && !isVanity && doctor.report.verdict === "recalibrate") {
        // The doctor's own suggestion — jump straight into recalibration.
        setDoctor(null)
        const storedSec = registered?.fingerprint?.interval
        const idx = FP_WINDOWS.findIndex((w) => w.sec === storedSec)
        setFpIdx(idx >= 0 ? idx : 0)
        return setFpPick(true)
      }
      return
    }
    if (alerts) {
      if (alerts.kind === "ready" && alerts.busy) return // a toggle is mid-flight
      if (name === "escape" || name === "q") return setAlerts(null)
      if (alerts.kind !== "ready") return
      if (name === "up" || name === "k") return setAlerts({ ...alerts, idx: Math.max(alerts.idx - 1, 0), flash: null })
      if (name === "down" || name === "j") return setAlerts({ ...alerts, idx: Math.min(alerts.idx + 1, alerts.providers.length - 1), flash: null })
      if ((name === "return" || name === "space" || name === " ") && site && alerts.providers.length > 0) {
        const p = alerts.providers[alerts.idx]!
        const on = !p.attachedAll
        setAlerts({ ...alerts, busy: true, flash: null })
        void toggleKumaAlert(site, p.id, on, alerts.monitorIds).then((r) => {
          setAlerts((prev) => {
            if (!prev || prev.kind !== "ready") return prev
            if (!r.ok) return { ...prev, busy: false, flash: `✕ ${r.error}` }
            const providers = prev.providers.map((q) => (q.id === p.id ? { ...q, attachedAll: on, attachedAny: on } : q))
            const n = prev.monitorIds.length
            return { ...prev, providers, busy: false, flash: `✓ ${p.name} ${on ? "now alerts" : "no longer alerts"} for ${n} monitor${n === 1 ? "" : "s"}` }
          })
          // Keep the header's passive summary in sync without a re-fetch.
          if (r.ok) {
            setAlertSummary((prev) =>
              prev?.kind === "ready" ? { kind: "ready", providers: prev.providers.map((q) => (q.id === p.id ? { ...q, attachedAll: on, attachedAny: on } : q)) } : prev,
            )
          }
        })
        return
      }
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
    if (bypassPick) {
      if (name === "left" || name === "up" || name === "h" || name === "k") return setBypassIdx((i) => Math.max(i - 1, 0))
      if (name === "right" || name === "down" || name === "l" || name === "j" || name === "tab") return setBypassIdx((i) => Math.min(i + 1, BYPASS_WINDOWS.length - 1))
      if (/^[1-5]$/.test(name)) return setBypassIdx(Number(name) - 1)
      if (name === "return" && site) {
        setBypassPick(false)
        return startBypassMonitorSetup(site, BYPASS_WINDOWS[bypassIdx]!.sec)
      }
      if (name === "escape" || name === "q") return setBypassPick(false)
      return
    }
    if (name === "c") return setShowConnect(true)
    if (name === "o" && site && op?.status !== "running") {
      const id = selected ? monitorIdFor(selected.key) : null
      if (kumaUrl && id != null) openUrl(`${kumaUrl}/dashboard/${id}`)
      return
    }
    // Move the left list's highlight — only reachable here since every modal
    // state above already returned.
    if ((name === "up" || name === "k") && site && op?.status !== "running") return setSelectedIdx((i) => Math.max(i - 1, 0))
    if ((name === "down" || name === "j") && site && op?.status !== "running") return setSelectedIdx((i) => Math.min(i + 1, entries.length - 1))
    if (name === "d" && !isVanity && site && op?.status !== "running") {
      // Pure HTTP — deliberately NOT gated on a Kuma connection.
      return runDoctor()
    }
    if (name === "n" && site && op?.status !== "running") {
      if (!kumaConfigured) return setShowConnect(true) // alert wiring lives in Kuma
      setAlerts({ kind: "loading" })
      void fetchKumaAlerts(site).then((r) => {
        setAlerts(r.ok ? { kind: "ready", providers: r.providers, monitorIds: r.monitorIds, idx: 0, busy: false, flash: null } : { kind: "error", error: r.error })
      })
      return
    }
    if (name === "r" && isVanity && site && op?.status !== "running") return setConfirmRotate(true)
    if (
      name === "x" &&
      site &&
      op?.status !== "running" &&
      (selected?.key === "fingerprint" || selected?.key === "bypass") &&
      monitorIdFor(selected.key) != null
    ) {
      return setConfirmRemove(selected.key)
    }
    // The single "act on whichever monitor is selected" key — replaces the old
    // per-kind f/b keys now that the right pane shows one monitor at a time.
    if (name === "a" && site && op?.status !== "running") {
      if (!kumaConfigured) return setShowConnect(true) // monitors need a connection
      if (selected?.key === "fingerprint") {
        const storedSec = registered?.fingerprint?.interval
        const idx = FP_WINDOWS.findIndex((w) => w.sec === storedSec)
        setFpIdx(idx >= 0 ? idx : 0)
        return setFpPick(true)
      }
      if (selected?.key === "bypass") {
        setBypassIdx(BYPASS_DEFAULT_IDX)
        return setBypassPick(true)
      }
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

      {connecting ? (
        <Centered>{renderConnect()}</Centered>
      ) : confirmRotate ? (
        <Centered>{renderRotateConfirm()}</Centered>
      ) : confirmRemove ? (
        <Centered>{renderRemoveConfirm()}</Centered>
      ) : doctor ? (
        <Centered>
          <Panel title=" Doctor — cache diagnosis " active>
            <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>{renderDoctor()}</box>
          </Panel>
        </Centered>
      ) : alerts ? (
        <Centered>
          <Panel title=" Alerts " active>
            <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>{renderAlerts()}</box>
          </Panel>
        </Centered>
      ) : (
        renderMonitorBrowser()
      )}

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

  // Full-screen browser: a narrow left list of this site's monitor kinds
  // (status dot + label) and a wide right detail pane for whichever one is
  // selected — mirrors ProviderConnect.tsx's two-Panel-in-a-row layout.
  function renderMonitorBrowser() {
    const alertLine = formatAlertSummary()
    return (
      <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
        {connectedVersion && (
          <>
            <text content={`● Uptime Kuma connected (${connectedVersion}).`} fg={theme.good} wrapMode="none" />
            <box style={{ height: 1 }} />
          </>
        )}
        <text content={isVanity ? "vanity page (full server monitoring)" : "site homepage (up/down + cert expiry)"} fg={theme.textDim} wrapMode="none" />
        <text content={kumaConfigured ? "Uptime Kuma: connected · c to reconnect" : "Uptime Kuma: not connected · c"} fg={kumaConfigured ? theme.good : theme.textFaint} wrapMode="none" />
        <text content={alertLine.text} fg={alertLine.color} wrapMode="none" />
        <box style={{ height: 1 }} />
        <box style={{ flexGrow: 1, flexDirection: "row", gap: 1 }}>
          <Panel title=" Monitors " active width={30}>
            <box style={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1 }}>
              {entries.map((e, i) => {
                const s = statusFor(e.key)
                const sel = i === safeIdx
                return (
                  <box key={e.key} style={{ flexDirection: "row", backgroundColor: sel ? theme.selectedBg : undefined }}>
                    <text content={sel ? "› " : "  "} fg={theme.brand} style={{ flexShrink: 0 }} />
                    <text content={`${statusDot(dotStatus(s))} `} fg={statusColor(dotStatus(s))} style={{ flexShrink: 0 }} />
                    <text content={e.label} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
                  </box>
                )
              })}
            </box>
          </Panel>
          <Panel title={selected ? ` ${selected.label} ` : " Monitor "} flexGrow={1} active>
            <box style={{ flexDirection: "column", width: 90, paddingTop: 1, paddingBottom: 1, paddingLeft: 1 }}>
              {op?.status === "error" && (
                <>
                  <text content={`✕ ${op.error}`} fg={theme.bad} />
                  <box style={{ height: 1 }} />
                </>
              )}
              {op?.status === "done" && (
                <>
                  <text content={`✓ ${op.detail}`} fg={theme.good} />
                  <box style={{ height: 1 }} />
                </>
              )}
              {op?.status === "running" ? (
                <box style={{ flexDirection: "row" }}>
                  <Spinner />
                  <text content={`  ${op.detail}`} fg={theme.textDim} wrapMode="none" />
                </box>
              ) : fpPick && selected?.key === "fingerprint" ? (
                <>
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
              ) : bypassPick && selected?.key === "bypass" ? (
                <>
                  <text content="Forces a real PHP render, catching a fatal hidden behind a still-" fg={theme.textDim} wrapMode="none" />
                  <text content="warm page cache. Costs the site a real render on every check, so" fg={theme.textDim} wrapMode="none" />
                  <text content="pick a loose window; use only on sites with a history of this." fg={theme.textDim} wrapMode="none" />
                  <box style={{ height: 1 }} />
                  <box style={{ flexDirection: "row" }}>
                    <text content="Check window:" fg={theme.textDim} style={{ flexShrink: 0 }} />
                    {BYPASS_WINDOWS.map((w, i) => (
                      <text key={w.label} content={i === bypassIdx ? `  ▸${w.label}` : `   ${w.label}`} fg={i === bypassIdx ? theme.brand : theme.textFaint} style={{ flexShrink: 0 }} />
                    ))}
                  </box>
                  <box style={{ height: 1 }} />
                  <text content="←/→ or 1-5 window · ⏎ register · esc cancel" fg={theme.textFaint} wrapMode="none" />
                </>
              ) : selected ? (
                <>
                  <text content={selected.tagline} fg={theme.text} wrapMode="none" />
                  <box style={{ height: 1 }} />
                  <text content={selected.detail} fg={theme.textDim} />
                  <box style={{ height: 1 }} />
                  <Field label="Status" value={statusFor(selected.key).value} valueColor={statusFor(selected.key).color} />
                  <Field
                    label="In Kuma"
                    value={monitorIdFor(selected.key) != null ? `#${monitorIdFor(selected.key)} · o opens it` : "not registered yet"}
                    valueColor={monitorIdFor(selected.key) != null ? theme.text : theme.textFaint}
                  />
                  <Field
                    label="Action"
                    value={(() => {
                      const removable = (selected.key === "fingerprint" || selected.key === "bypass") && monitorIdFor(selected.key) != null
                      const base =
                        selected.key === "fingerprint"
                          ? registered?.fingerprintId
                            ? "a — recalibrate"
                            : "a — calibrate & register"
                          : selected.key === "bypass"
                            ? registered?.bypassId
                              ? "a — recalibrate"
                              : "a — register (opt-in)"
                            : statusFor(selected.key).registered
                              ? "a — repair / re-register"
                              : "a — register"
                      return removable ? `${base} · x — remove` : base
                    })()}
                  />
                  {selected.key !== "fingerprint" && selected.key !== "bypass" && statusFor(selected.key).registered && (
                    <text content="(safe to re-run any time — re-syncs with Kuma, e.g. if a monitor was" fg={theme.textFaint} wrapMode="none" />
                  )}
                  {selected.key !== "fingerprint" && selected.key !== "bypass" && statusFor(selected.key).registered && (
                    <text content="deleted directly in Kuma, or sudo just got connected for PHP-fatal)" fg={theme.textFaint} wrapMode="none" />
                  )}
                </>
              ) : null}
            </box>
          </Panel>
        </box>
      </box>
    )
  }

  function renderRotateConfirm() {
    return (
      <Panel title=" Rotate monitoring secrets " active>
        <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
          <text content="Rotate this site's monitoring secrets?" fg={theme.warn} wrapMode="none" />
          <text content="A new push URL and health key are minted; the old ones stop" fg={theme.textDim} wrapMode="none" />
          <text content="working immediately. Kuma monitor history is kept." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="y / ⏎ rotate · esc cancel" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderRemoveConfirm() {
    const label = confirmRemove === "fingerprint" ? "front-page" : "cache-bypass"
    return (
      <Panel title=" Remove monitor " active>
        <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`Remove the ${label} monitor?`} fg={theme.warn} wrapMode="none" />
          <text content="Deletes it in Kuma — its history is gone for good. Pressing" fg={theme.textDim} wrapMode="none" />
          <text content="a afterward re-opens the picker to add it back from scratch." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="y / ⏎ remove · esc cancel" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderDoctor() {
    if (!doctor) return null
    if (doctor.kind === "loading") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content="  Examining the live site (cached vs fresh render)…" fg={theme.textDim} wrapMode="none" />
        </box>
      )
    }
    const r = doctor.report
    const glyph = { ok: "✓", warn: "!", bad: "✕", info: "·" } as const
    const gColor = { ok: theme.good, warn: theme.warn, bad: theme.bad, info: theme.textFaint } as const
    const vColor = r.verdict === "healthy" ? theme.good : r.verdict === "stale-cache" || r.verdict === "down" || r.verdict === "partial-outage" ? theme.bad : theme.warn
    return (
      <>
        {r.checks.map((c, i) => (
          <box key={i} style={{ flexDirection: "row" }}>
            <text content={`${glyph[c.status]} ${c.label.padEnd(13)}`} fg={gColor[c.status]} style={{ flexShrink: 0 }} />
            <text content={c.detail} fg={c.status === "bad" ? theme.bad : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
        ))}
        <box style={{ height: 1 }} />
        <text content={r.summary} fg={vColor} wrapMode="none" />
        {r.runbook.length > 0 && (
          <>
            <box style={{ height: 1 }} />
            {r.runbook.map((line, i) => (
              <text key={i} content={`  ${line}`} fg={line.startsWith("#") ? theme.textFaint : theme.text} wrapMode="none" />
            ))}
          </>
        )}
        <box style={{ height: 1 }} />
        <text content={`d re-run${r.verdict === "recalibrate" ? " · f recalibrate" : ""} · esc back`} fg={theme.textFaint} wrapMode="none" />
      </>
    )
  }

  function renderAlerts() {
    if (!alerts) return null
    if (alerts.kind === "loading") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content="  Reading notification providers from Kuma…" fg={theme.textDim} wrapMode="none" />
        </box>
      )
    }
    if (alerts.kind === "error") {
      return (
        <>
          <text content={`✕ ${alerts.error}`} fg={theme.bad} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="esc back" fg={theme.textFaint} wrapMode="none" />
        </>
      )
    }
    if (alerts.providers.length === 0) {
      return (
        <>
          <text content="No notification providers in Uptime Kuma yet." fg={theme.text} wrapMode="none" />
          <text content="Add one in Kuma → Settings → Notifications (Telegram, email, …)," fg={theme.textDim} wrapMode="none" />
          <text content="then press n again — SpinupTUI wires it to this site's checks." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="esc back" fg={theme.textFaint} wrapMode="none" />
        </>
      )
    }
    const n = alerts.monitorIds.length
    return (
      <>
        <text content={`Alerts — where this site's ${n} check${n === 1 ? "" : "s"} notify:`} fg={theme.text} wrapMode="none" />
        <box style={{ height: 1 }} />
        {alerts.providers.map((p, i) => {
          const glyph = p.attachedAll ? "✓" : p.attachedAny ? "◐" : "○"
          const glyphColor = p.attachedAll ? theme.good : p.attachedAny ? theme.warn : theme.textFaint
          const suffix = p.attachedAny && !p.attachedAll ? " (some monitors only — ⏎ attaches to all)" : !p.active ? " (paused in Kuma)" : ""
          return (
            <box key={p.id} style={{ flexDirection: "row" }}>
              <text content={i === alerts.idx ? "❯ " : "  "} fg={theme.brand} style={{ flexShrink: 0 }} />
              <text content={glyph} fg={glyphColor} style={{ flexShrink: 0 }} />
              <text content={` ${p.name}${suffix}`} fg={i === alerts.idx ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
            </box>
          )
        })}
        <box style={{ height: 1 }} />
        {alerts.busy ? (
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Rewiring…" fg={theme.textDim} wrapMode="none" />
          </box>
        ) : alerts.flash ? (
          <text content={alerts.flash} fg={alerts.flash.startsWith("✓") ? theme.good : theme.bad} wrapMode="none" />
        ) : (
          <text content="↑↓ select · ⏎ toggle on/off · esc done" fg={theme.textFaint} wrapMode="none" />
        )}
      </>
    )
  }

  function hints() {
    if (connecting) return [{ key: "⏎", label: "next / connect" }, { key: "esc", label: "back" }]
    if (confirmRotate) return [{ key: "y/⏎", label: "rotate" }, { key: "esc", label: "cancel" }]
    if (confirmRemove) return [{ key: "y/⏎", label: "remove" }, { key: "esc", label: "cancel" }]
    if (doctor) return doctor.kind === "ready" ? [{ key: "d", label: "re-run" }, { key: "esc", label: "back" }] : [{ key: "esc", label: "back" }]
    if (alerts) return alerts.kind === "ready" && alerts.providers.length > 0 ? [{ key: "↑↓", label: "select" }, { key: "⏎", label: "toggle" }, { key: "esc", label: "done" }] : [{ key: "esc", label: "back" }]
    if (fpPick) return [{ key: "←/→", label: "window" }, { key: "⏎", label: "calibrate" }, { key: "esc", label: "cancel" }]
    if (bypassPick) return [{ key: "←/→", label: "window" }, { key: "⏎", label: "register" }, { key: "esc", label: "cancel" }]
    if (op?.status === "running") return [{ key: "esc", label: "background" }]
    const base: { key: string; label: string }[] = [{ key: "↑↓", label: "select monitor" }]
    if (isVanity) base.push({ key: "R", label: kumaConfigured ? "refresh page + monitors" : "refresh page" })
    if (isVanity) base.push({ key: "r", label: "rotate secrets" })
    base.push({
      key: "a",
      label:
        selected?.key === "fingerprint"
          ? registered?.fingerprintId
            ? "recalibrate front page"
            : "front-page check"
          : selected?.key === "bypass"
            ? registered?.bypassId
              ? "recalibrate cache-bypass"
              : "cache-bypass check"
            : statusFor(selected?.key ?? "").registered
              ? "repair monitors"
              : "add monitors",
    })
    if (selected && (selected.key === "fingerprint" || selected.key === "bypass") && monitorIdFor(selected.key) != null) {
      base.push({ key: "x", label: "remove monitor" })
    }
    if (!isVanity) base.push({ key: "d", label: "doctor" })
    if (selected && monitorIdFor(selected.key) != null) base.push({ key: "o", label: "open in Kuma" })
    base.push({ key: "n", label: "alerts" })
    base.push({ key: "c", label: kumaConfigured ? "reconnect Kuma" : "connect Kuma" })
    return [...base, { key: "esc", label: "close" }]
  }
}

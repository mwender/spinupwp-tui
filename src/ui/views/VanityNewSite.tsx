// "Connect this server with a vanity site" overlay (backlog item 5). Opened from
// the Sites-panel empty state on a 0-site server. Orchestrates the multi-step
// build (DNS A record → propagate → create site → HTTPS → SSH-key handoff → seed
// index.php) via the store's resumable VanityJob; this view is just the window
// onto it. Confirm gate up front (real production DNS + site writes).

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { Panel, Centered, Field, Spinner, Steps, type StepRow } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, isKeyGrantInFlight, VANITY_PROPAGATE_TIMEOUT_MS, type VanityStep } from "../store.tsx"
import { openUrl } from "../../lib/open.ts"
import { siteSftpUrl } from "../../lib/spinupweb.ts"
import { deriveSiteUser } from "../../lib/vanitySite.ts"

// Display order of the steps in the checklist (https omitted when SSL is skipped).
const STEP_LABELS: { step: VanityStep; label: string }[] = [
  { step: "dns", label: "Write DNS A record" },
  { step: "propagate", label: "Wait for DNS to propagate" },
  { step: "site", label: "Create the site" },
  { step: "https", label: "Enable HTTPS (Let's Encrypt)" },
  { step: "sshkey", label: "Add your SSH key" },
  { step: "seed", label: "Publish the page" },
  { step: "monitor", label: "Register Uptime Kuma monitors" },
  { step: "cron", label: "Install the heartbeat cron" },
]
const STEP_ORDER: VanityStep[] = STEP_LABELS.map((s) => s.step)

// ms → "m:ss" for the propagation timer.
function fmtClock(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

export function VanityNewSite() {
  const { vanityServer: server, setVanityServer, vanityJob: job, startVanity, vanitySshKeyDone, vanitySkipSsl, vanityKeepWaiting, vanityStopWaiting, vanityRetry, vanitySkipKuma, clearVanity, vanityHealthKeyFor, kumaConfigured, accountSlug, setInputMode, sites, isSudoConnected, keyGrants, startGrantRemembered, preferredGrantKeys, clearGrantKey, sudoConnectServer, setSudoConnectServer } = useStore()

  const [siteUser, setSiteUser] = useState(() => (server ? deriveSiteUser(server.name) : ""))
  const [editingUser, setEditingUser] = useState(false)

  // Tick once a second while we're waiting on DNS, so the propagate row's timer
  // (count-down before timeout, count-up once "keep waiting") stays live.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (job?.step !== "propagate") return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [job?.step])
  const propElapsed = job?.propagateStartedAt ? Math.max(0, now - job.propagateStartedAt) : 0
  const propRemaining = Math.max(0, VANITY_PROPAGATE_TIMEOUT_MS - propElapsed)

  // Auto-grant context for the SSH-key step: the just-created site, whether sudo is
  // connected on the server, and any in-flight/settled grant for that site.
  const newSite = job?.siteId ? sites.find((s) => s.id === job.siteId) : undefined
  const sudoOn = server ? isSudoConnected(server.id) : false
  const grant = newSite ? keyGrants.get(newSite.id) : undefined
  const granting = !!grant && isKeyGrantInFlight(grant)
  const canAutoGrant = sudoOn && preferredGrantKeys.length > 0 && !!newSite

  // Once the auto-grant lands the key on the new site, advance to publish — no
  // SpinupWP round-trip needed (the seed step can now SSH in).
  useEffect(() => {
    if (job?.step === "sshkey" && job.siteId && keyGrants.get(job.siteId)?.status === "done") {
      clearGrantKey(job.siteId)
      vanitySshKeyDone()
    }
  }, [job, keyGrants, vanitySshKeyDone, clearGrantKey])

  const close = () => {
    setInputMode(false)
    // Forget only a finished build on close. An errored/incomplete one is kept so
    // you can return to it (header badge / press V on its server); discard with x.
    if (job?.step === "done") clearVanity()
    setVanityServer(null)
  }

  const discard = () => {
    setInputMode(false)
    clearVanity()
    setVanityServer(null)
  }

  useKeyboard((key) => {
    // While the connect-sudo overlay is layered on top, let it own the keyboard.
    if (sudoConnectServer) return
    // Normalize shift+letter to uppercase so `S` (connect sudo) matches, like the
    // server browser does.
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw
    if (editingUser) {
      if (name === "escape" || name === "return") {
        setEditingUser(false)
        setInputMode(false)
      }
      return
    }

    // No job yet → the confirm screen.
    if (!job) {
      // S — connect sudo on this server now (so the key auto-grants later). Opens
      // the Connect-sudo overlay layered on top; only offered when not connected.
      if (name === "S" && server && !sudoOn) return setSudoConnectServer(server)
      if (name === "e") {
        setEditingUser(true)
        setInputMode(true)
        return
      }
      if (name === "y") {
        if (server && siteUser.trim()) startVanity(server, { siteUser: siteUser.trim() })
        return
      }
      if (name === "escape" || name === "q") return close()
      return
    }

    // Job in flight / settled.
    if (job.step === "propagate" && job.propagateTimedOut) {
      if (name === "s") return vanitySkipSsl()
      if (name === "w") return vanityKeepWaiting()
    }
    // Keep-waiting (count-up) mode: continue the normal flow now, or skip SSL.
    if (job.step === "propagate" && job.keepWaiting && !job.propagateTimedOut) {
      if (name === "c") return vanityStopWaiting()
      if (name === "s") return vanitySkipSsl()
    }
    if (job.step === "sshkey") {
      // S — connect sudo here if it isn't yet (then `g` becomes available).
      if (name === "S" && server && !sudoOn) return setSudoConnectServer(server)
      // g — grant the saved keys via the connected sudo session (then auto-publish).
      // Available once sudo is connected and you have a saved key choice; retries on error.
      if (name === "g" && canAutoGrant && newSite && (!grant || grant.status === "error")) {
        return startGrantRemembered([newSite])
      }
      if (name === "o") {
        if (accountSlug && job.siteId) openUrl(siteSftpUrl(job.siteId, accountSlug))
        return
      }
      if (name === "return") return vanitySshKeyDone()
    }
    if (job.step === "error") {
      if (name === "r") return vanityRetry()
      // Monitoring failures are skippable — the site itself is already live.
      if (name === "s" && (job.failedStep === "monitor" || job.failedStep === "cron")) return vanitySkipKuma()
      if (name === "x") return discard()
    }
    if (job.step === "done" && name === "o") {
      openUrl((job.sslSkipped ? "http://" : "https://") + job.hostname)
      return
    }
    if (name === "escape" || name === "q") return close()
  })

  if (!server) return null

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
        zIndex: 215,
      }}
    >
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="✦ Connect server  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={server.name} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function stepRows(): StepRow[] {
    const cur = job?.step
    const failed = job?.step === "error" ? job.failedStep : undefined
    return STEP_LABELS.filter((s) => !(s.step === "https" && job?.sslSkipped))
      .filter((s) => !((s.step === "monitor" || s.step === "cron") && !kumaConfigured))
      .map(({ step, label }) => {
      let state: StepRow["state"] = "pending"
      if (failed === step) state = "failed"
      else if (cur === "done") state = "done"
      else if (cur && step === cur) {
        // The SSH-key step waits on the user (unless a grant is actively running),
        // so mark it "waiting" rather than spinning like the automated steps.
        state = step === "sshkey" && !granting ? "waiting" : "active"
      } else if (cur && STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf(cur)) state = "done"
      // Live timer on the propagate row: count-down to the timeout, then (once the
      // user keeps waiting) count up from that same baseline.
      let detail: string | undefined
      if (step === "propagate" && cur === "propagate" && !job?.propagateTimedOut) {
        detail = job?.keepWaiting ? `${fmtClock(propElapsed)} elapsed` : `${fmtClock(propRemaining)} left`
      }
      return { label, state, detail }
    })
  }

  function renderBody() {
    // Confirm gate (no job yet).
    if (!job) {
      return (
        <Panel title=" Connect this server with a vanity site " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <text content="A tiny placeholder site at the server's own hostname — so there's" fg={theme.textDim} />
            <text content="a site user to hold your SSH key and Spinup can work with it." fg={theme.textDim} />
            <box style={{ height: 1 }} />
            <Field label="Domain" value={server!.name} />
            <Field label="Points to" value={server!.ip_address ?? "—"} />
            <box style={{ flexDirection: "row" }}>
              <text content="Site user  " fg={theme.textDim} />
              {editingUser ? (
                <input
                  focused
                  value={siteUser}
                  onInput={setSiteUser}
                  onSubmit={() => {
                    setEditingUser(false)
                    setInputMode(false)
                  }}
                  style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
                />
              ) : (
                <text content={siteUser || "—"} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
              )}
            </box>
            <box style={{ height: 1 }} />
            <text content="We'll write an A record (Route 53), create the site, enable HTTPS," fg={theme.textFaint} wrapMode="none" />
            <text content="add your SSH key, then publish the page." fg={theme.textFaint} wrapMode="none" />
            {!sudoOn && (
              <>
                <box style={{ height: 1 }} />
                <text content="○ Sudo not connected — press S to connect now" fg={theme.warn} wrapMode="none" />
                <text content="  so Spinup can add your SSH key for you (no SpinupWP step)." fg={theme.textFaint} wrapMode="none" />
              </>
            )}
            <box style={{ height: 1 }} />
            <text content={editingUser ? "⏎ done editing" : sudoOn ? "e edit user · y create · q cancel" : "S connect sudo · e edit user · y create · q cancel"} fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // Done.
    if (job.step === "done") {
      const healthKey = vanityHealthKeyFor(job.hostname)
      return (
        <Panel title=" Server connected " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ " fg={theme.good} style={{ flexShrink: 0 }} />
              <text content={job.hostname} fg={theme.accent} wrapMode="none" style={{ flexShrink: 1 }} />
            </box>
            <text content="The vanity site is live and the server now has a site." fg={theme.textDim} wrapMode="none" />
            {healthKey && (
              <>
                <box style={{ height: 1 }} />
                <text content="The page doubles as a health endpoint for any uptime tool:" fg={theme.textDim} wrapMode="none" />
                <text content="  /?healthz — up/down (503 on high load or low disk)" fg={theme.textFaint} wrapMode="none" />
                <text content={`  /?format=json&key=${healthKey}`} fg={theme.textFaint} wrapMode="none" />
              </>
            )}
            <box style={{ height: 1 }} />
            <text content="o open in browser · Esc to close" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // Error.
    if (job.step === "error") {
      return (
        <Panel title=" Vanity build failed " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <Steps rows={stepRows()} />
            <box style={{ height: 1 }} />
            <text content={`✕ ${job.error ?? "Something went wrong."}`} fg={theme.bad} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text
              content={job.failedStep === "monitor" || job.failedStep === "cron" ? "r retry · s skip monitoring (site is live) · x discard · Esc later" : "r retry this step · x discard · Esc keep for later"}
              fg={theme.textFaint}
              wrapMode="none"
            />
          </box>
        </Panel>
      )
    }

    // SSH-key handoff. This step WAITS on you (it won't auto-fire), so the primary
    // action is a bright ❯ call-to-action; secondary options stay faint below.
    if (job.step === "sshkey") {
      const grantFailed = grant?.status === "error"
      return (
        <Panel title=" Add your SSH key — your turn " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <Steps rows={stepRows()} />
            <box style={{ height: 1 }} />
            <text content="The site exists, but Spinup can't SSH in until your key is on the" fg={theme.textDim} wrapMode="none" />
            <text content="site user." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            {granting ? (
              <box style={{ flexDirection: "row" }}>
                <Spinner />
                <text content="  Granting your saved key(s) via sudo…" fg={theme.textDim} wrapMode="none" />
              </box>
            ) : grantFailed ? (
              <>
                <text content={`✕ ${grant?.error ?? "Grant failed."}`} fg={theme.bad} wrapMode="none" />
                <box style={{ height: 1 }} />
                <text content="❯ Press g to try the grant again" fg={theme.brand} wrapMode="none" />
                <box style={{ height: 1 }} />
                <text content="or  o SpinupWP · ⏎ I added it manually · Esc later" fg={theme.textFaint} wrapMode="none" />
              </>
            ) : canAutoGrant ? (
              <>
                <box style={{ flexDirection: "row" }}>
                  <text content="● sudo connected — " fg={theme.good} wrapMode="none" />
                  <text content="ready to add your saved key(s)." fg={theme.textDim} wrapMode="none" />
                </box>
                <box style={{ height: 1 }} />
                <text content="❯ Press g to grant your key(s) & publish" fg={theme.brand} wrapMode="none" />
                <box style={{ height: 1 }} />
                <text content="or  o SpinupWP · ⏎ I added it manually · Esc later" fg={theme.textFaint} wrapMode="none" />
              </>
            ) : (
              <>
                <text content="Connect sudo and Spinup adds your key for you — or add it in" fg={theme.textDim} wrapMode="none" />
                <text content="SpinupWP (the site's SFTP & SSH → Site User), then come back." fg={theme.textFaint} wrapMode="none" />
                <box style={{ height: 1 }} />
                <text content="❯ Press S to connect sudo" fg={theme.brand} wrapMode="none" />
                <box style={{ height: 1 }} />
                <text content={accountSlug && job.siteId ? "or  o SpinupWP · ⏎ I've added it · Esc later" : "or  ⏎ I've added it · Esc later"} fg={theme.textFaint} wrapMode="none" />
              </>
            )}
          </box>
        </Panel>
      )
    }

    // Propagation timed out → skip/keep-waiting prompt.
    if (job.step === "propagate" && job.propagateTimedOut) {
      return (
        <Panel title=" DNS is taking a while " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <Steps rows={stepRows()} />
            <box style={{ height: 1 }} />
            <text content={`${job.hostname} hasn't resolved to ${job.serverIp} yet.`} fg={theme.textDim} wrapMode="none" />
            <text content="HTTPS needs it to resolve first. You can skip SSL for now (the" fg={theme.textFaint} wrapMode="none" />
            <text content="site stays HTTP; enable SSL later) or keep waiting." fg={theme.textFaint} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="s skip SSL for now · w keep waiting · Esc later" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // In-flight checklist (dns / propagate / site / https / seed).
    const keepWaiting = job.step === "propagate" && job.keepWaiting
    return (
      <Panel title=" Connecting the server " active>
        <box style={{ flexDirection: "column", width: 60, paddingTop: 1, paddingBottom: 1 }}>
          <Steps rows={stepRows()} />
          <box style={{ height: 1 }} />
          {keepWaiting ? (
            <>
              <text content={`Still waiting for ${job.hostname} to resolve (${fmtClock(propElapsed)}).`} fg={theme.textDim} wrapMode="none" />
              <text content="c continue now · s skip SSL · Esc background" fg={theme.textFaint} wrapMode="none" />
            </>
          ) : (
            <text content="Esc — this keeps running in the background." fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  function hints() {
    if (!job) {
      if (editingUser) return [{ key: "⏎", label: "done" }]
      return [...(sudoOn ? [] : [{ key: "S", label: "connect sudo" }]), { key: "e", label: "edit user" }, { key: "y", label: "create" }, { key: "q", label: "cancel" }]
    }
    if (job.step === "done") return [{ key: "o", label: "open site" }, { key: "esc", label: "close" }]
    if (job.step === "error") {
      const skippable = job.failedStep === "monitor" || job.failedStep === "cron"
      return [{ key: "r", label: "retry" }, ...(skippable ? [{ key: "s", label: "skip monitoring" }] : []), { key: "x", label: "discard" }, { key: "esc", label: "later" }]
    }
    if (job.step === "sshkey") {
      const granting = grant && isKeyGrantInFlight(grant)
      if (granting) return [{ key: "esc", label: "background" }]
      const grantHint = canAutoGrant || grant?.status === "error" ? [{ key: "g", label: "grant my key(s)" }] : []
      const connectHint = !sudoOn ? [{ key: "S", label: "connect sudo" }] : []
      return [...grantHint, ...connectHint, ...(accountSlug && job.siteId ? [{ key: "o", label: "SpinupWP" }] : []), { key: "⏎", label: "added it" }, { key: "esc", label: "later" }]
    }
    if (job.step === "propagate" && job.propagateTimedOut) {
      return [{ key: "s", label: "skip SSL" }, { key: "w", label: "wait" }, { key: "esc", label: "later" }]
    }
    if (job.step === "propagate" && job.keepWaiting) {
      return [{ key: "c", label: "continue now" }, { key: "s", label: "skip SSL" }, { key: "esc", label: "background" }]
    }
    return [{ key: "esc", label: "background" }]
  }
}

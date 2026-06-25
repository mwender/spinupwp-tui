// "Connect this server with a vanity site" overlay (backlog item 5). Opened from
// the Sites-panel empty state on a 0-site server. Orchestrates the multi-step
// build (DNS A record → propagate → create site → HTTPS → SSH-key handoff → seed
// index.php) via the store's resumable VanityJob; this view is just the window
// onto it. Confirm gate up front (real production DNS + site writes).

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { Panel, Centered, Field, Steps, type StepRow } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, type VanityStep } from "../store.tsx"
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
]
const STEP_ORDER: VanityStep[] = STEP_LABELS.map((s) => s.step)

export function VanityNewSite() {
  const { vanityServer: server, setVanityServer, vanityJob: job, startVanity, vanitySshKeyDone, vanitySkipSsl, vanityKeepWaiting, vanityRetry, clearVanity, accountSlug, setInputMode } = useStore()

  const [siteUser, setSiteUser] = useState(() => (server ? deriveSiteUser(server.name) : ""))
  const [editingUser, setEditingUser] = useState(false)

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
    const name = key.name ?? ""
    if (editingUser) {
      if (name === "escape" || name === "return") {
        setEditingUser(false)
        setInputMode(false)
      }
      return
    }

    // No job yet → the confirm screen.
    if (!job) {
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
    if (job.step === "sshkey") {
      if (name === "o") {
        if (accountSlug && job.siteId) openUrl(siteSftpUrl(job.siteId, accountSlug))
        return
      }
      if (name === "return") return vanitySshKeyDone()
    }
    if (job.step === "error") {
      if (name === "r") return vanityRetry()
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
    return STEP_LABELS.filter((s) => !(s.step === "https" && job?.sslSkipped)).map(({ step, label }) => {
      let state: StepRow["state"] = "pending"
      if (failed === step) state = "failed"
      else if (cur === "done") state = "done"
      else if (cur && step === cur) state = "active"
      else if (cur && STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf(cur)) state = "done"
      return { label, state }
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
            <text content="hand you off to add your SSH key, then publish the page." fg={theme.textFaint} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content={editingUser ? "⏎ done editing" : "e edit user · y create · q cancel"} fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // Done.
    if (job.step === "done") {
      return (
        <Panel title=" Server connected " active>
          <box style={{ flexDirection: "column", width: 60, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ " fg={theme.good} style={{ flexShrink: 0 }} />
              <text content={job.hostname} fg={theme.accent} wrapMode="none" style={{ flexShrink: 1 }} />
            </box>
            <text content="The vanity site is live and the server now has a site." fg={theme.textDim} wrapMode="none" />
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
            <text content="r retry this step · x discard · Esc keep for later" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // SSH-key handoff (manual park).
    if (job.step === "sshkey") {
      return (
        <Panel title=" Add your SSH key " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <Steps rows={stepRows()} />
            <box style={{ height: 1 }} />
            <text content="The site exists, but Spinup can't SSH in until your key is on the" fg={theme.textDim} wrapMode="none" />
            <text content="site user. Add it in SpinupWP (the site's SFTP & SSH → Site User)," fg={theme.textDim} wrapMode="none" />
            <text content="then come back." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content={accountSlug && job.siteId ? "o open SpinupWP · ⏎ I've added it (publish) · Esc later" : "⏎ I've added it (publish) · Esc later"} fg={theme.textFaint} wrapMode="none" />
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
    return (
      <Panel title=" Connecting the server " active>
        <box style={{ flexDirection: "column", width: 60, paddingTop: 1, paddingBottom: 1 }}>
          <Steps rows={stepRows()} />
          <box style={{ height: 1 }} />
          <text content="Esc — this keeps running in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    if (!job) {
      return editingUser ? [{ key: "⏎", label: "done" }] : [{ key: "e", label: "edit user" }, { key: "y", label: "create" }, { key: "q", label: "cancel" }]
    }
    if (job.step === "done") return [{ key: "o", label: "open site" }, { key: "esc", label: "close" }]
    if (job.step === "error") return [{ key: "r", label: "retry" }, { key: "x", label: "discard" }, { key: "esc", label: "later" }]
    if (job.step === "sshkey") {
      return [...(accountSlug && job.siteId ? [{ key: "o", label: "SpinupWP" }] : []), { key: "⏎", label: "added it" }, { key: "esc", label: "later" }]
    }
    if (job.step === "propagate" && job.propagateTimedOut) {
      return [{ key: "s", label: "skip SSL" }, { key: "w", label: "wait" }, { key: "esc", label: "later" }]
    }
    return [{ key: "esc", label: "background" }]
  }
}

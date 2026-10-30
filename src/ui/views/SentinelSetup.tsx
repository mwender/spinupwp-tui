// Sentinel's overlay (Modules tab): guided setup on ⏎, a digest preview on `t`.
// Setup shows what it would do and applies on `y`, the confirm-before-firing
// pattern; attach comes first, because Sentinel watches what's in the registry.
// Applying ends with one real tick, so "done" means it read Kuma.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { loadConfig } from "../../config.ts"
import { SpinupWPClient } from "../../api/client.ts"
import { applySetup, loadAttachPlan, planSetup, saveAttach } from "../../lib/cliSentinel.ts"
import { composeDigest, gatherDigest } from "../../lib/sentinelDigest.ts"
import { loadFlags, sentinelSettings } from "../../lib/sentinelState.ts"
import type { AttachPlan } from "../../lib/sentinelAttach.ts"
import type { KumaMonitor } from "../../lib/uptimeKuma.ts"

type Agent = "claude" | "codex" | "none"

export function SentinelOverlay() {
  const { sentinelOverlay, setSentinelOverlay } = useStore()
  const close = () => setSentinelOverlay(null)
  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="◉ Sentinel  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={sentinelOverlay === "digest" ? "today's digest, not sent" : "watch the fleet"} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
      {sentinelOverlay === "digest" ? <DigestPreview close={close} /> : <Setup close={close} />}
    </box>
  )
}

function DigestPreview({ close }: { close: () => void }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const cfg = loadConfig()
    void gatherDigest(sentinelSettings(cfg), cfg, new SpinupWPClient(cfg), { dryRun: true })
      .then((d) => live && setText(composeDigest(d, loadFlags()).text))
      .catch((err: Error) => live && setText(`Couldn't build the digest: ${err.message}`))
    return () => {
      live = false
    }
  }, [])
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") close()
  })
  return (
    <>
      <Centered>
        {text === null ? (
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Checking the fleet (this can take a minute)…" fg={theme.textDim} wrapMode="none" />
          </box>
        ) : (
          <Panel title=" Digest preview " active>
            <box style={{ flexDirection: "column", width: 84, paddingTop: 1, paddingBottom: 1 }}>
              {text.split("\n").map((l, i) => (
                <text key={i} content={truncate(l, 82) || " "} fg={theme.text} wrapMode="none" />
              ))}
            </box>
          </Panel>
        )}
      </Centered>
      <StatusBar hints={[{ key: "esc", label: "close" }]} showGlobal={false} />
    </>
  )
}

function Setup({ close }: { close: () => void }) {
  const saved = loadConfig().sentinel?.diagnosis?.agent
  const [agent, setAgent] = useState<Agent>(saved === null ? "none" : (saved ?? (Bun.which("claude") ? "claude" : Bun.which("codex") ? "codex" : "none")))
  const [attach, setAttach] = useState<{ plan: AttachPlan; monitors: KumaMonitor[] } | null>(null)
  const [attachError, setAttachError] = useState<string | null>(null)
  const [likely, setLikely] = useState(false)
  const [phase, setPhase] = useState<"confirm" | "applying" | "done" | "error">("confirm")
  const [message, setMessage] = useState("")
  const plan = planSetup({ agent })

  useEffect(() => {
    if (!loadConfig().uptimeKuma) return
    let live = true
    void loadAttachPlan()
      .then((a) => live && setAttach(a))
      .catch((err: Error) => live && setAttachError(err.message))
    return () => {
      live = false
    }
  }, [])

  const apply = () => {
    setPhase("applying")
    void (async () => {
      const attached = attach ? await saveAttach(attach.plan, attach.monitors, likely) : 0
      const r = await applySetup(planSetup({ agent }).next)
      setMessage(r.ok ? `${attached ? `Attached ${attached} monitor(s). ` : ""}Sentinel read Kuma and is watching from now.` : r.message)
      setPhase(r.ok ? "done" : "error")
    })().catch((err: Error) => {
      setMessage(err.message)
      setPhase("error")
    })
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()
    if (phase !== "confirm") return
    if (name === "a") return setAgent((a) => (a === "claude" ? "codex" : a === "codex" ? "none" : "claude"))
    if (name === "l" && attach?.plan.likely.length) return setLikely((v) => !v)
    if (name === "y" && plan.blockers.length === 0) apply()
  })

  const a = attach?.plan
  return (
    <>
      <Centered>
        {phase === "applying" ? (
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Attaching monitors and running a first tick…" fg={theme.textDim} wrapMode="none" />
          </box>
        ) : phase !== "confirm" ? (
          <Panel title={phase === "done" ? " Sentinel is on " : " Couldn't finish "} active>
            <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
              <text content={`${phase === "done" ? "✓" : "✕"} ${message}`} fg={phase === "done" ? theme.good : theme.bad} />
              <box style={{ height: 1 }} />
              <text content="Esc to close" fg={theme.textFaint} />
            </box>
          </Panel>
        ) : (
          <Panel title=" Set up Sentinel " active>
            <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
              <text content="Runs as Scheduler jobs: a check every 5 minutes, a digest at 08:00." fg={theme.text} />
              <box style={{ height: 1 }} />
              <text content={`Agent: ${agent}`} fg={theme.accent} wrapMode="none" />
              <text content={`Workspace: ${truncate(plan.next.workspace ?? "~/SpinupTUI/sentinel", 62)}`} fg={theme.textDim} wrapMode="none" />
              <box style={{ height: 1 }} />
              {!a && !attachError && loadConfig().uptimeKuma && <text content="Reading your Kuma monitors…" fg={theme.textDim} wrapMode="none" />}
              {attachError && <text content={`Couldn't read Kuma: ${truncate(attachError, 58)}`} fg={theme.warn} wrapMode="none" />}
              {a && (
                <>
                  <text content={`Monitors: ${a.exact.length} to attach, ${a.already} already attached (nothing changes in Kuma)`} fg={theme.text} wrapMode="none" />
                  {a.likely.length > 0 && <text content={`  ${a.likely.length} likely match(es): ${likely ? "will attach" : "skipped"} (l to change)`} fg={theme.textDim} wrapMode="none" />}
                  {a.unmonitored.length > 0 && <text content={`  ${a.unmonitored.length} site(s) have no monitor`} fg={theme.textDim} wrapMode="none" />}
                </>
              )}
              <box style={{ height: 1 }} />
              {plan.notes.map((n) => (
                <text key={n} content={`Note: ${n}`} fg={theme.textFaint} />
              ))}
              {plan.blockers.map((b) => (
                <text key={b} content={`✕ ${b}`} fg={theme.bad} />
              ))}
              <box style={{ height: 1 }} />
              <text content={plan.blockers.length ? "Fix the above first · Esc to close" : "Press y to turn it on · a change agent · Esc to cancel"} fg={plan.blockers.length ? theme.warn : theme.text} wrapMode="none" />
            </box>
          </Panel>
        )}
      </Centered>
      <StatusBar
        hints={phase === "confirm" && !plan.blockers.length ? [{ key: "y", label: "turn on" }, { key: "a", label: "agent" }, { key: "esc", label: "cancel" }] : [{ key: "esc", label: "close" }]}
        showGlobal={false}
      />
    </>
  )
}

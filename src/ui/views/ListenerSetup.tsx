// Beacon's listener overlay (Modules tab, l on Beacon). Not installed: shows
// exactly what `spinuptui beacon listener install --plan` would write and run,
// and applies it on `y`; applying ends when the listener has started and said
// hello on the pager. Installed: shows whether it's answering, and removes it on
// `x` then `y`.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import {
  applyListenerInstall,
  applyListenerUninstall,
  binHasListener,
  listenerHealth,
  NO_LISTENER,
  planListenerInstall,
  planListenerUninstall,
  type ListenerApplyResult,
  type ListenerPlanResult,
} from "../../lib/beaconListenInstall.ts"

type Phase = "confirm" | "applying" | "done" | "error" | "installed" | "confirm-remove" | "removed"

export function ListenerSetup() {
  const { setListenerSetupOpen } = useStore()
  const [health] = useState(() => listenerHealth())
  const [plan, setPlan] = useState<ListenerPlanResult>(() => planListenerInstall())
  const [phase, setPhase] = useState<Phase>(health ? "installed" : plan.ok ? "confirm" : "error")
  // Same refusal as `listener install --plan`, checked once on open.
  useEffect(() => {
    if (!plan.ok) return
    void binHasListener(plan).then((has) => {
      if (has) return
      setPlan(NO_LISTENER)
      setPhase((p) => (p === "confirm" ? "error" : p))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [stage, setStage] = useState("")
  const [result, setResult] = useState<ListenerApplyResult | null>(null)
  const [live, setLive] = useState(true)
  useEffect(() => () => setLive(false), [])

  const close = () => setListenerSetupOpen(false)

  const apply = () => {
    if (!plan.ok) return
    setPhase("applying")
    void applyListenerInstall(plan, (s) => live && setStage(s)).then((r) => {
      setResult(r)
      setPhase(r.ok ? "done" : "error")
    })
  }

  const remove = () => {
    setPhase("applying")
    setStage("removing the listener")
    void applyListenerUninstall(planListenerUninstall()).then(() => setPhase("removed"))
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (phase === "applying") return
    if (name === "escape" || name === "q") return phase === "confirm-remove" ? setPhase("installed") : close()
    if (phase === "confirm" && name === "y" && plan.ok) return apply()
    if (phase === "installed" && name === "x") return setPhase("confirm-remove")
    if (phase === "installed" && name === "r" && plan.ok) return setPhase("confirm")
    if (phase === "confirm-remove" && name === "y") return remove()
    if (phase === "error" && name === "r" && plan.ok) return setPhase("confirm")
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
        zIndex: 210,
      }}
    >
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="Beacon  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content="let the pager answer you" fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
      <Centered>{body()}</Centered>
      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function body() {
    if (phase === "applying") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={`  ${stage || "Installing…"}`} fg={theme.textDim} wrapMode="none" />
          </box>
          <box style={{ height: 1 }} />
          <text content="Install finishes when the listener has started and said hello on your pager." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }
    if (phase === "removed") {
      return (
        <Panel title=" Removed " active>
          <box style={{ flexDirection: "column", width: 70, paddingTop: 1, paddingBottom: 1 }}>
            <text content="✓ The listener is gone. The pager still sends; it just won't answer." fg={theme.good} />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    if (phase === "installed" || phase === "confirm-remove") {
      const h = health!
      return (
        <Panel title=" Beacon's listener " active>
          <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`${h.ok ? "✓" : "✗"} ${truncate(h.detail, 72)}`} fg={h.ok ? theme.good : theme.bad} />
            <box style={{ height: 1 }} />
            <text content="Send these to your bot in Telegram:" fg={theme.textDim} />
            <text content="  /jobs  this station's scheduled jobs, with Extend on the ones expiring soon" fg={theme.accent} wrapMode="none" />
            <text content="  /help  everything it answers" fg={theme.accent} wrapMode="none" />
            <box style={{ height: 1 }} />
            {phase === "confirm-remove" ? (
              <text content="Remove the listener? y to remove · Esc to keep it" fg={theme.warn} wrapMode="none" />
            ) : (
              <text content={`${plan.ok ? "r reinstall (repairs the unit)  ·  " : ""}x remove  ·  Esc to close`} fg={theme.textFaint} wrapMode="none" />
            )}
          </box>
        </Panel>
      )
    }
    if (phase === "done" && result?.ok) {
      return (
        <Panel title=" Installed " active>
          <box style={{ flexDirection: "column", width: 70, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`✓ ${result.label} is listening on "${result.channel}".`} fg={theme.good} />
            <box style={{ height: 1 }} />
            <text content="Try it: send /jobs to your bot in Telegram." fg={theme.text} />
            <box style={{ height: 1 }} />
            {result.notes.map((n) => (
              <text key={n} content={`Note: ${n}`} fg={theme.textFaint} />
            ))}
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    if (phase === "error" || !plan.ok) {
      const r = !plan.ok ? plan : result && !result.ok ? result : null
      return (
        <Panel title=" Can't install " active>
          <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`✕ ${r?.message ?? "Something went wrong."}`} fg={theme.bad} />
            {r?.remedy && (
              <>
                <box style={{ height: 1 }} />
                <text content={r.remedy} fg={theme.textDim} />
              </>
            )}
            <box style={{ height: 1 }} />
            <text content={plan.ok ? "Press r to see the plan again · Esc to close" : "Esc to close"} fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    return (
      <Panel title=" Install Beacon's listener " active>
        <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
          <text content="Kept running by launchd, so you can message the pager back:" fg={theme.text} />
          <text content={`  ${truncate(plan.programArguments.join(" "), 72)}`} fg={theme.accent} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content={`Unit: ${truncate(plan.unitPath, 68)}`} fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          {plan.commands.map((c) => (
            <text key={c} content={`· ${truncate(c, 72)}`} fg={theme.textDim} wrapMode="none" />
          ))}
          <box style={{ height: 1 }} />
          {plan.notes.map((n) => (
            <text key={n} content={`Note: ${n}`} fg={theme.textFaint} />
          ))}
          <box style={{ height: 1 }} />
          <text content="Press y to install · Esc to cancel" fg={theme.text} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    if (phase === "confirm" && plan.ok) return [{ key: "y", label: "install" }, { key: "esc", label: "cancel" }]
    if (phase === "installed") return [...(plan.ok ? [{ key: "r", label: "reinstall" }] : []), { key: "x", label: "remove" }, { key: "esc", label: "close" }]
    if (phase === "confirm-remove") return [{ key: "y", label: "remove" }, { key: "esc", label: "keep" }]
    if (phase === "error" && plan.ok) return [{ key: "r", label: "back to plan" }, { key: "esc", label: "close" }]
    return [{ key: "esc", label: "close" }]
  }
}

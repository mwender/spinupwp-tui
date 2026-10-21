// Scheduler's install overlay (Modules tab, ⏎ on Scheduler): shows exactly what
// `spinuptui scheduler install --plan` would write and run, and applies it on
// `y` — the confirm-before-firing pattern. Applying ends with the proving tick
// (a tick that really ran under launchd), so "done" here means the station's
// clock is running, not just that a file was written.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { applyInstall, binHasScheduler, NO_SCHEDULER, planInstall, type ApplyResult, type PlanResult } from "../../lib/schedulerInstall.ts"

type Phase = "confirm" | "applying" | "done" | "error"

export function SchedulerInstall() {
  const { setSchedulerInstallOpen } = useStore()
  const [plan, setPlan] = useState<PlanResult>(() => planInstall())
  // Same refusal as `install --plan`: don't offer a plan whose binary has no
  // Scheduler (it would launch the dashboard under launchd).
  useEffect(() => {
    if (!plan.ok) return
    void binHasScheduler(plan).then((has) => {
      if (!has) {
        setPlan(NO_SCHEDULER)
        setPhase("error")
      }
    })
    // Checked once, for the plan computed on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [phase, setPhase] = useState<Phase>(plan.ok ? "confirm" : "error")
  const [stage, setStage] = useState("")
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [live, setLive] = useState(true)
  useEffect(() => () => setLive(false), [])

  const close = () => setSchedulerInstallOpen(false)

  const apply = () => {
    if (!plan.ok) return
    setPhase("applying")
    void applyInstall(plan, (s) => live && setStage(s)).then((r) => {
      setResult(r)
      setPhase(r.ok ? "done" : "error")
    })
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()
    if (phase === "confirm" && name === "y" && plan.ok && plan.platform === "darwin") return apply()
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
        <text content="⏱ Scheduler  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content="install the station's clock" fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
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
          <text content="Install finishes with a real tick from launchd (up to a minute)." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }
    if (phase === "done" && result?.ok) {
      return (
        <Panel title=" Installed " active>
          <box style={{ flexDirection: "column", width: 70, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`✓ ${result.label} is ticking: its first run under launchd was at ${new Date(result.tickAt).toLocaleTimeString()}.`} fg={theme.good} />
            <box style={{ height: 1 }} />
            <text content="Queue a follow-up from any session:" fg={theme.textDim} />
            <text content={'  spinuptui scheduler add <id> --kind spinuptui --when "YYYY-MM-DD 08:00" \\'} fg={theme.accent} wrapMode="none" />
            <text content={'      --expires YYYY-MM-DD --created-by "…" -- incidents example.com'} fg={theme.accent} wrapMode="none" />
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
    const darwin = plan.platform === "darwin"
    return (
      <Panel title=" Install Scheduler's dispatcher " active>
        <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
          <text content="Runs at login and every 5 minutes, unattended:" fg={theme.text} />
          <text content={`  ${truncate(plan.programArguments.join(" "), 72)}`} fg={theme.accent} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content={`Unit: ${truncate(plan.unitPath, 68)}`} fg={theme.textDim} wrapMode="none" />
          <text content={`PATH: ${truncate(plan.env.PATH ?? "", 68)}`} fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          {plan.commands.map((c) => (
            <text key={c} content={`· ${truncate(c, 72)}`} fg={theme.textDim} wrapMode="none" />
          ))}
          <box style={{ height: 1 }} />
          {plan.notes.map((n) => (
            <text key={n} content={`Note: ${n}`} fg={theme.textFaint} />
          ))}
          <box style={{ height: 1 }} />
          <text
            content={darwin ? "Press y to install · Esc to cancel" : "Installing on Linux isn't supported yet · Esc to close"}
            fg={darwin ? theme.text : theme.warn}
            wrapMode="none"
          />
        </box>
      </Panel>
    )
  }

  function hints() {
    if (phase === "confirm" && plan.ok && plan.platform === "darwin") {
      return [
        { key: "y", label: "install" },
        { key: "esc", label: "cancel" },
      ]
    }
    if (phase === "error" && plan.ok) {
      return [
        { key: "r", label: "back to plan" },
        { key: "esc", label: "close" },
      ]
    }
    return [{ key: "esc", label: "close" }]
  }
}

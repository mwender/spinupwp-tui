// The station heartbeat overlay (Modules tab, `h` on Scheduler): the same flow
// as `spinuptui scheduler heartbeat setup`, with the confirm-before-firing
// pattern. With a saved Kuma login it finds or creates this station's push
// monitor; without one it takes a push URL made by hand. Once set, it shows the
// last ping and can send a test or remove it.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { loadConfig } from "../../config.ts"
import { readLastTick } from "../../lib/schedulerJobs.ts"
import { stationName } from "../../lib/schedulerGit.ts"
import {
  applyStationPlan,
  connectHeartbeat,
  loadStationPlan,
  pagerProblem,
  removeHeartbeat,
  sendHeartbeat,
  stationPlanText,
  tickHeartbeat,
  type StationMonitorPlan,
} from "../../lib/heartbeat.ts"

type Phase = "status" | "loading" | "choose" | "confirm" | "manual" | "working" | "done" | "error" | "confirmRemove"

const INPUT_STYLE = { backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }
const WIDTH = 76

export function HeartbeatSetup() {
  const { setHeartbeatSetupOpen, setInputMode } = useStore()
  const host = stationName()
  const [current, setCurrent] = useState(() => loadConfig().scheduler?.heartbeat ?? null)
  const hasKuma = !!loadConfig().uptimeKuma
  const [phase, setPhase] = useState<Phase>(current ? "status" : hasKuma ? "loading" : "manual")
  const [plan, setPlan] = useState<StationMonitorPlan | null>(null)
  const [pick, setPick] = useState(0)
  const [url, setUrl] = useState("")
  const [message, setMessage] = useState<{ text: string; remedy?: string; good?: boolean } | null>(null)

  const close = () => setHeartbeatSetupOpen(false)

  const startPlan = () => {
    setPhase("loading")
    void loadStationPlan(host).then((r) => {
      if (!r.ok) {
        setMessage({ text: r.message, remedy: r.remedy })
        return setPhase("error")
      }
      setPlan(r.plan)
      setPick(0)
      setPhase(!r.plan.existing && r.plan.needChoice ? "choose" : "confirm")
    })
  }

  useEffect(() => {
    if (phase === "loading" && !plan) startPlan()
    // Only the first load; later loads go through startPlan directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (phase !== "manual") return
    setInputMode(true)
    return () => setInputMode(false)
  }, [phase, setInputMode])

  const finish = (text: string, status: "up" | "down") => {
    setCurrent(loadConfig().scheduler?.heartbeat ?? null)
    const why = status === "down" ? ` It says "down" because ${pagerProblem()}; the next tick says "up" once that's fixed.` : ""
    const tail = loadConfig().scheduler?.dispatcher ? " Every dispatcher tick pings it from now on." : " This machine has no dispatcher yet: install Scheduler (⏎ on its card) so ticks ping it."
    setMessage({ text: text + why + tail, good: true })
    setPhase("done")
  }

  const apply = () => {
    if (!plan) return
    setPhase("working")
    void applyStationPlan(plan, host).then((r) => {
      if (!r.ok) {
        setMessage({ text: r.message, remedy: r.remedy })
        return setPhase("error")
      }
      finish(`${r.created ? `Created "${plan.name}" (#${r.created})` : `Reused "${plan.name}"`} and sent the first ping (status ${r.status}).`, r.status)
    })
  }

  const submitUrl = () => {
    if (!url.trim()) return
    setPhase("working")
    void connectHeartbeat(url.trim(), host).then((r) => {
      if (!r.ok) {
        setMessage({ text: r.message, remedy: r.remedy })
        return setPhase("error")
      }
      finish(`Saved. Kuma took the ping (status ${r.status}).`, r.status)
    })
  }

  const test = () => {
    if (!current) return
    setPhase("working")
    const t = tickHeartbeat(0, [], pagerProblem())
    void sendHeartbeat(current.url, t.status, `${host}: test ping (${t.msg})`).then((r) => {
      setMessage(r.ok ? { text: `Kuma took the test ping (status ${t.status}).`, good: true } : { text: `Kuma didn't take the ping: ${r.error}`, remedy: "Check that the monitor is active and that this machine can reach Kuma." })
      setPhase(r.ok ? "done" : "error")
    })
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (phase === "manual") {
      if (name === "escape") close()
      return
    }
    if (phase === "working" || phase === "loading") return
    if (name === "escape" || name === "q") return phase === "confirmRemove" ? setPhase("status") : close()
    if (phase === "status") {
      if (name === "t") return test()
      if (name === "s" && hasKuma) return startPlan()
      if (name === "x") return setPhase("confirmRemove")
    }
    if (phase === "confirmRemove" && name === "y") {
      void removeHeartbeat().then(() => {
        setCurrent(null)
        setMessage({ text: "Removed. Pause or delete the monitor in Kuma too, or it will report this station as down.", good: true })
        setPhase("done")
      })
      return
    }
    if (phase === "choose" && plan) {
      if (name === "up" || name === "k") return setPick((i) => Math.max(0, i - 1))
      if (name === "down" || name === "j") return setPick((i) => Math.min(plan.available.length - 1, i + 1))
      if (name === "return") {
        setPlan({ ...plan, chosen: [plan.available[pick]!], needChoice: null })
        return setPhase("confirm")
      }
    }
    if (phase === "confirm" && name === "y") return apply()
    if (phase === "error" || phase === "done") {
      if (name === "u") {
        setUrl("")
        return setPhase("manual")
      }
      if (name === "r" && hasKuma) return startPlan()
    }
  })

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="♥ Station heartbeat  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content="know when this machine stops, from somewhere else" fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
      <Centered>{body()}</Centered>
      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function intro() {
    return (
      <>
        <text content="If this machine is off, its spinuptui is broken, or Scheduler's LaunchAgent is gone, nothing here can page you. So every Scheduler tick pings an Uptime Kuma push monitor running on another machine, and when the pings stop, Kuma alerts you itself." fg={theme.textDim} />
        <box style={{ height: 1 }} />
      </>
    )
  }

  function body() {
    if (phase === "loading" || phase === "working") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content={phase === "loading" ? "  Asking Uptime Kuma…" : "  Talking to Uptime Kuma…"} fg={theme.textDim} wrapMode="none" />
        </box>
      )
    }
    if (phase === "status" && current) {
      const last = readLastTick()?.heartbeat ?? null
      const pager = pagerProblem()
      return (
        <Panel title=" Station heartbeat " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`✓ Pings ${new URL(current.url).host} at the end of every Scheduler tick.`} fg={theme.good} wrapMode="none" />
            <text content={`Set ${current.setAt.slice(0, 10)}.`} fg={theme.textDim} />
            <box style={{ height: 1 }} />
            <text
              content={last ? `Last ping: ${last.ok ? "accepted" : `failed (${truncate(last.error ?? "", 50)})`}, status ${last.status}.` : "No Scheduler tick has pinged it yet."}
              fg={last && !last.ok ? theme.bad : theme.text}
            />
            {pager && <text content={`Pings say "down" right now: ${pager}.`} fg={theme.warn} />}
          </box>
        </Panel>
      )
    }
    if (phase === "choose" && plan) {
      return (
        <Panel title=" Who should Kuma alert? " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            {intro()}
            <text content="This Kuma has several notifications and none is the default. Pick the one that should wake you when this station goes quiet:" fg={theme.text} />
            <box style={{ height: 1 }} />
            {plan.available.map((n, i) => (
              <text key={n.id} content={`${i === pick ? "▸ " : "  "}${n.name}`} fg={i === pick ? theme.accent : theme.text} wrapMode="none" />
            ))}
          </box>
        </Panel>
      )
    }
    if (phase === "confirm" && plan) {
      const { steps, notes } = stationPlanText(plan)
      return (
        <Panel title=" The plan " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            {intro()}
            {steps.map((s, i) => (
              <text key={s} content={`${i + 1}. ${s}`} fg={theme.text} />
            ))}
            <box style={{ height: 1 }} />
            {notes.map((n) => (
              <text key={n} content={n} fg={theme.textFaint} />
            ))}
            <box style={{ height: 1 }} />
            <text content="Press y to do it · Esc to cancel" fg={theme.text} wrapMode="none" />
          </box>
        </Panel>
      )
    }
    if (phase === "manual") {
      return (
        <Panel title=" Connect a Kuma push monitor " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            {intro()}
            <text content="SpinupTUI has no Kuma login to create the monitor with (connect one with M on any site). Or make it yourself: in Kuma, Add New Monitor → Monitor Type: Push, Heartbeat Interval 900 seconds, with a notification. Then paste its push URL:" fg={theme.text} />
            <box style={{ height: 1 }} />
            <input focused value={url} placeholder="https://kuma.example.com/api/push/…" onInput={(v: string) => setUrl(v)} onSubmit={submitUrl} style={INPUT_STYLE} />
            <box style={{ height: 1 }} />
            <text content="SpinupTUI pings it once and saves it only if Kuma accepts the ping." fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    if (phase === "confirmRemove") {
      return (
        <Panel title=" Remove the heartbeat? " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <text content="Scheduler stops pinging Kuma. The monitor stays in Kuma and will report this station as down, so pause or delete it there too." fg={theme.text} />
            <box style={{ height: 1 }} />
            <text content="Press y to remove · Esc to keep it" fg={theme.text} wrapMode="none" />
          </box>
        </Panel>
      )
    }
    const good = phase === "done" && message?.good
    return (
      <Panel title={good ? " Done " : " Didn't work "} active>
        <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`${good ? "✓" : "✕"} ${message?.text ?? ""}`} fg={good ? theme.good : theme.bad} />
          {message?.remedy && (
            <>
              <box style={{ height: 1 }} />
              <text content={message.remedy} fg={theme.textDim} />
            </>
          )}
        </box>
      </Panel>
    )
  }

  function hints() {
    const esc = { key: "esc", label: "close" }
    if (phase === "status") return [{ key: "t", label: "test ping" }, ...(hasKuma ? [{ key: "s", label: "redo setup" }] : []), { key: "x", label: "remove" }, esc]
    if (phase === "choose") return [{ key: "↑↓", label: "choose" }, { key: "⏎", label: "use it" }, esc]
    if (phase === "confirm") return [{ key: "y", label: "do it" }, { key: "esc", label: "cancel" }]
    if (phase === "manual") return [{ key: "⏎", label: "ping & save" }, { key: "esc", label: "cancel" }]
    if (phase === "confirmRemove") return [{ key: "y", label: "remove" }, { key: "esc", label: "keep" }]
    if (phase === "error") return [...(hasKuma ? [{ key: "r", label: "try again" }] : []), { key: "u", label: "paste a URL instead" }, esc]
    return [esc]
  }
}

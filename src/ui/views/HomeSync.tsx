// The SpinupTUI folder overlay (Modules tab, `f`): where your jobs and reports
// live, and sharing that folder across machines — `spinuptui home sync` with
// the confirm-before-firing pattern. Pick how to share it, give a name or URL,
// see the plan, press y. Nothing runs git until then.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { openUrl } from "../../lib/open.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { applySync, describeShare, ensureHome, ghReady, homeStatus, planSync, tilde, type ApplyResult, type HomeStatus, type SyncOptions, type SyncPlan } from "../../lib/home.ts"

type Phase = "loading" | "pick" | "input" | "planning" | "confirm" | "blocked" | "applying" | "done" | "error"

interface Choice {
  key: keyof SyncOptions
  label: string
  detail: string
  prompt: string
  placeholder: string
  initial: string
}

const INPUT_STYLE = { backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }

export function HomeSync() {
  const { setHomeSyncOpen, setInputMode } = useStore()
  const [phase, setPhase] = useState<Phase>("loading")
  const [status, setStatus] = useState<HomeStatus | null>(null)
  const [gh, setGh] = useState<string | null>(null) // why gh can't be used; null = it can
  const [selected, setSelected] = useState(0)
  const [value, setValue] = useState("")
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)

  const choices: Choice[] = [
    {
      key: "github",
      label: "Create a private GitHub repository for it",
      detail: gh ? `${gh} Or make one yourself and use the next option.` : "Uses the GitHub CLI you're signed in to.",
      prompt: "Repository name (or owner/name)",
      placeholder: "spinuptui-home",
      initial: "spinuptui-home",
    },
    {
      key: "remote",
      label: "Use an empty private repository I've made",
      detail: "Any git host: GitHub, GitLab, Gitea, your own server.",
      prompt: "Repository URL",
      placeholder: "git@github.com:you/spinuptui-home.git",
      initial: "",
    },
    {
      key: "clone",
      label: "Set this machine up from another machine's folder",
      detail: "For a second machine: clones the repository you shared from the first.",
      prompt: "Repository URL",
      placeholder: "git@github.com:you/spinuptui-home.git",
      initial: "",
    },
  ]
  const choice = choices[selected]!

  const close = () => setHomeSyncOpen(false)

  const makePlan = (opts: SyncOptions) => {
    setPhase("planning")
    void planSync(opts).then((p) => {
      setPlan(p)
      setPhase(p.blockers.length ? "blocked" : "confirm")
    })
  }

  useEffect(() => {
    void Promise.all([homeStatus(), ghReady()]).then(([s, why]) => {
      setStatus(s)
      setGh(why)
      // No usable gh: start on the option that works without it.
      if (why) setSelected(1)
      // Already shared: the plan is "push what's pending", or nothing.
      if (s.git && s.remote) makePlan({})
      else setPhase("pick")
    })
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The input owns the keyboard while it's showing.
  useEffect(() => {
    if (phase !== "input") return
    setInputMode(true)
    return () => setInputMode(false)
  }, [phase, setInputMode])

  const apply = () => {
    if (!plan) return
    setPhase("applying")
    void applySync(plan).then(async (r) => {
      if (r.ok) ensureHome()
      setResult(r)
      setStatus(await homeStatus())
      setPhase(r.ok ? "done" : "error")
    })
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (phase === "input") {
      if (name === "escape") setPhase("pick")
      return
    }
    if (name === "escape" || name === "q") return close()
    if (name === "o" && status?.exists) return openUrl(status.path)
    if (phase === "pick") {
      if (name === "up" || name === "k") return setSelected((i) => Math.max(0, i - 1))
      if (name === "down" || name === "j") return setSelected((i) => Math.min(choices.length - 1, i + 1))
      if (name === "return") {
        if (choice.key === "github" && gh) return
        setValue(choice.initial)
        return setPhase("input")
      }
    }
    if (phase === "confirm" && name === "y" && plan && plan.steps.length) return apply()
    if ((phase === "blocked" || phase === "error") && name === "r" && !(status?.git && status.remote)) return setPhase("pick")
  })

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="▤ Your SpinupTUI folder  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={status ? tilde(status.path) : ""} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
      <Centered>{body()}</Centered>
      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function header() {
    if (!status) return null
    return (
      <>
        <text content="Your Scheduler jobs and reports live here, and later other modules' work too." fg={theme.text} />
        <text
          content={`${status.exists ? "" : "Created the first time a module writes to it. "}Its README.md explains each part.`}
          fg={theme.textDim}
        />
        <box style={{ height: 1 }} />
        <box style={{ flexDirection: "row" }}>
          <text content="Now: " fg={theme.textDim} style={{ flexShrink: 0 }} />
          <text content={truncate(describeShare(status), 66)} fg={status.git && status.remote ? theme.good : theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        </box>
        {status.station && (
          <text content={`Its jobs run on ${status.station === status.thisMachine ? "this machine" : status.station}.`} fg={theme.textDim} wrapMode="none" />
        )}
        <box style={{ height: 1 }} />
      </>
    )
  }

  function body() {
    if (phase === "loading" || phase === "planning" || phase === "applying") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content={phase === "applying" ? "  Sharing the folder…" : phase === "planning" ? "  Checking the repository…" : "  Looking at the folder…"} fg={theme.textDim} wrapMode="none" />
        </box>
      )
    }
    if (phase === "pick") {
      return (
        <Panel title=" Share it across machines " active>
          <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
            {header()}
            <text content="Shared through a private git repository, you can queue jobs from any machine" fg={theme.text} />
            <text content="and read the reports anywhere. Scheduler pulls it before each run and pushes" fg={theme.text} />
            <text content="the reports after." fg={theme.text} />
            <box style={{ height: 1 }} />
            {choices.map((c, i) => {
              const off = c.key === "github" && !!gh
              const sel = i === selected
              return (
                <box key={c.key} style={{ flexDirection: "column" }}>
                  <text content={`${sel ? "▸ " : "  "}${c.label}`} fg={off ? theme.textFaint : sel ? theme.accent : theme.text} wrapMode="none" />
                  {sel && <text content={`    ${c.detail}`} fg={off ? theme.warn : theme.textDim} />}
                </box>
              )
            })}
          </box>
        </Panel>
      )
    }
    if (phase === "input") {
      return (
        <Panel title={` ${choice.label} `} active>
          <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
            <text content={choice.prompt} fg={theme.accent} />
            <input
              focused
              value={value}
              placeholder={choice.placeholder}
              onInput={(v: string) => setValue(v)}
              onSubmit={() => value.trim() && makePlan({ [choice.key]: value.trim() })}
              style={INPUT_STYLE}
            />
            <box style={{ height: 1 }} />
            <text content={choice.key === "clone" ? "Nothing changes until you've seen the plan." : "Keep it private: reports name your sites and clients. Nothing changes until you've seen the plan."} fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    if (phase === "blocked" && plan) {
      return (
        <Panel title=" Can't share it yet " active>
          <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
            {plan.blockers.map((b) => (
              <box key={b.reason + b.message} style={{ flexDirection: "column" }}>
                <text content={`✕ ${b.message}`} fg={theme.bad} />
                {b.remedy && <text content={`  ${b.remedy}`} fg={theme.textDim} />}
                <box style={{ height: 1 }} />
              </box>
            ))}
          </box>
        </Panel>
      )
    }
    if (phase === "confirm" && plan) {
      if (!plan.steps.length) {
        return (
          <Panel title=" Shared " active>
            <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
              {header()}
              <text content="✓ Shared and up to date. Nothing to do." fg={theme.good} />
              <box style={{ height: 1 }} />
              <text content={`On another machine: spinuptui home sync --clone ${status?.remote ?? "<url>"} --plan`} fg={theme.textFaint} />
              {plan.notes.map((n) => (
                <text key={n} content={n} fg={theme.warn} />
              ))}
            </box>
          </Panel>
        )
      }
      return (
        <Panel title=" The plan " active>
          <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
            {header()}
            {plan.steps.map((s, i) => (
              <text key={s.label} content={`${i + 1}. ${truncate(s.label, 70)}`} fg={theme.text} wrapMode="none" />
            ))}
            <box style={{ height: 1 }} />
            {plan.notes.map((n) => (
              <text key={n} content={n} fg={theme.textFaint} />
            ))}
            <box style={{ height: 1 }} />
            <text content="Press y to do it · Esc to cancel" fg={theme.text} wrapMode="none" />
          </box>
        </Panel>
      )
    }
    if (phase === "done" && result) {
      return (
        <Panel title=" Shared " active>
          <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
            {result.done.map((d) => (
              <text key={d} content={`✓ ${truncate(d, 72)}`} fg={theme.good} wrapMode="none" />
            ))}
            <box style={{ height: 1 }} />
            {status && <text content={`${tilde(status.path)} is ${truncate(describeShare(status), 56)}.`} fg={theme.text} />}
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    return (
      <Panel title=" Stopped " active>
        <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
          {result?.done.map((d) => (
            <text key={d} content={`✓ ${truncate(d, 72)}`} fg={theme.good} wrapMode="none" />
          ))}
          <text content={`✕ ${result?.failed?.step ?? "Something went wrong"}: ${result?.failed?.message ?? ""}`} fg={theme.bad} />
          <box style={{ height: 1 }} />
          <text content="The steps above it are done. Fix this and run it again: it picks up where it stopped." fg={theme.textDim} />
        </box>
      </Panel>
    )
  }

  function hints() {
    const open = status?.exists ? [{ key: "o", label: "open folder" }] : []
    if (phase === "pick") return [{ key: "↑↓", label: "choose" }, { key: "⏎", label: "next" }, ...open, { key: "esc", label: "close" }]
    if (phase === "input") return [{ key: "⏎", label: "see the plan" }, { key: "esc", label: "back" }]
    if (phase === "confirm" && plan?.steps.length) return [{ key: "y", label: "do it" }, ...open, { key: "esc", label: "cancel" }]
    if (phase === "blocked" || phase === "error") return [...(status?.git && status.remote ? [] : [{ key: "r", label: "back" }]), ...open, { key: "esc", label: "close" }]
    return [...open, { key: "esc", label: "close" }]
  }
}

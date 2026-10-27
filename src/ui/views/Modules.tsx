// Modules tab: the parts of SpinupTUI that keep working after the TUI is closed.
// A view over the module contract (src/modules): each shipped module's status on
// this machine, plus the ones still to come, greyed out. This is also where a
// module gets set up — discovery and turning it on happen in the same place.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { toast } from "../toast.ts"
import { MODULES, UPCOMING_MODULES } from "../../modules/index.ts"
import type { ModuleId, ModuleStatus } from "../../modules/contract.ts"
import { beaconFromConfig, beaconSend, testMessage } from "../../lib/beacon.ts"
import { loadConfig } from "../../config.ts"
import { upcomingRuns } from "../../modules/scheduler.ts"
import { describeShare, homeStatus, tilde, type HomeStatus } from "../../lib/home.ts"

interface Card {
  id: ModuleId
  name: string
  summary: string
  dependsOn: ModuleId[]
  upcoming: boolean
}

const CARDS: Card[] = [
  ...MODULES.map((m) => ({ id: m.id, name: m.name, summary: m.summary, dependsOn: m.dependsOn, upcoming: false })),
  ...UPCOMING_MODULES.map((m) => ({ ...m, upcoming: true })),
]

const NAMES = new Map(CARDS.map((c) => [c.id, c.name]))

function stateLabel(card: Card, status: ModuleStatus | undefined): { dot: string; label: string; color: string } {
  if (card.upcoming) return { dot: "·", label: "coming soon", color: theme.textFaint }
  if (!status) return { dot: "○", label: "checking…", color: theme.textDim }
  if (status.state === "ok") return { dot: "●", label: "set up", color: theme.good }
  if (status.state === "degraded") return { dot: "●", label: "needs attention", color: theme.warn }
  return { dot: "○", label: "not set up", color: theme.textDim }
}

export function Modules({ rows }: { rows: number }) {
  const store = useStore()
  const { route, inputMode, overlayOpen, beaconSetupOpen, setBeaconSetupOpen, schedulerInstallOpen, setSchedulerInstallOpen, homeSyncOpen, setHomeSyncOpen } = store
  const [selected, setSelected] = useState(0)
  const [statuses, setStatuses] = useState<Map<ModuleId, ModuleStatus>>(new Map())
  const [testing, setTesting] = useState(false)

  // Recompute on open and whenever a setup overlay closes (it may have changed
  // the config). status() is cheap and never sends anything.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (beaconSetupOpen || schedulerInstallOpen || homeSyncOpen) return
    let live = true
    void Promise.all(MODULES.map((m) => m.status())).then((list) => {
      if (live) setStatuses(new Map(list.map((s) => [s.id, s])))
    })
    return () => {
      live = false
    }
  }, [beaconSetupOpen, schedulerInstallOpen, homeSyncOpen, tick])

  const isActive = route === "modules" && !inputMode && !overlayOpen
  const card = CARDS[selected]!
  const status = statuses.get(card.id)

  const sendTest = () => {
    if (testing) return
    setTesting(true)
    void beaconSend(beaconFromConfig(loadConfig()), testMessage()).then((r) => {
      setTesting(false)
      setTick((t) => t + 1)
      if (r.ok) toast.success(`Test page sent via ${r.channel}`)
      else toast.error(r.message)
    })
  }

  useKeyboard((key) => {
    if (!isActive) return
    switch (key.name) {
      case "up":
      case "k":
        return setSelected((i) => moveSelection(i, -1, CARDS.length))
      case "down":
      case "j":
        return setSelected((i) => moveSelection(i, 1, CARDS.length))
      case "return":
      case "s":
        if (card.id === "beacon") return setBeaconSetupOpen(true)
        if (card.id === "scheduler") return setSchedulerInstallOpen(true)
        return
      case "f":
        if (card.id === "scheduler") return setHomeSyncOpen(true)
        return
      case "t":
        if (card.id === "beacon" && status && status.state !== "not_configured") return sendTest()
        return
    }
  })

  const beaconReady = card.id === "beacon" && status !== undefined && status.state !== "not_configured"

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row", padding: 1, gap: 1 }}>
        <Panel title=" Modules " active width={40}>
          <List
            items={CARDS}
            selectedIndex={selected}
            viewportRows={Math.max(3, rows - 4)}
            focused
            keyFor={(c) => c.id}
            renderRow={(c, sel) => {
              const s = stateLabel(c, statuses.get(c.id))
              return (
                <>
                  <text content={s.dot + " "} fg={s.color} style={{ flexShrink: 0 }} />
                  <text
                    content={c.name}
                    fg={c.upcoming ? theme.textFaint : sel ? theme.text : theme.textDim}
                    wrapMode="none"
                    style={{ flexGrow: 1, flexShrink: 1 }}
                  />
                  <text content={" " + s.label} fg={s.color} wrapMode="none" style={{ flexShrink: 0 }} />
                </>
              )
            }}
          />
        </Panel>

        <Panel title={` ${card.name} `} flexGrow={1}>
          <box style={{ flexDirection: "column" }}>
            <text content={card.summary} fg={card.upcoming ? theme.textDim : theme.text} />
            <box style={{ height: 1 }} />
            {card.dependsOn.length > 0 && (
              <text content={`Builds on: ${card.dependsOn.map((d) => NAMES.get(d) ?? d).join(", ")}`} fg={theme.textFaint} />
            )}
            {card.upcoming ? <UpcomingDetail /> : <ModuleDetail card={card} status={status} />}
          </box>
        </Panel>
      </box>
      <StatusBar
        hints={[
          { key: "↑↓/jk", label: "select" },
          ...(card.id === "beacon" ? [{ key: "⏎", label: beaconReady ? "reconfigure" : "set up" }] : []),
          ...(card.id === "scheduler"
            ? [
                { key: "⏎", label: status && status.state !== "not_configured" ? "reinstall" : "install" },
                { key: "f", label: "your folder" },
              ]
            : []),
          ...(beaconReady ? [{ key: "t", label: testing ? "sending…" : "test page" }] : []),
        ]}
      />
    </box>
  )
}

function UpcomingDetail() {
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ height: 1 }} />
      <text content="Coming soon" fg={theme.purple} attributes={1} />
      <text content="Not in this version yet. It will appear here, ready to set up, when it ships." fg={theme.textFaint} />
    </box>
  )
}

function ModuleDetail({ card, status }: { card: Card; status: ModuleStatus | undefined }) {
  if (!status) return <text content="Checking…" fg={theme.textDim} />
  const s = stateLabel(card, status)
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ height: 1 }} />
      <box style={{ flexDirection: "row" }}>
        <text content={`${s.dot} `} fg={s.color} style={{ flexShrink: 0 }} />
        <text content={status.summary} fg={s.color} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
      {status.checks.length > 0 && (
        <>
          <box style={{ height: 1 }} />
          {status.checks.map((c) => (
            <box key={c.name} style={{ flexDirection: "row" }}>
              <text content={c.ok ? "✓ " : "✗ "} fg={c.ok ? theme.good : theme.bad} style={{ flexShrink: 0 }} />
              <text content={`${c.name}: `} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
              <text content={truncate(c.detail, 80)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
            </box>
          ))}
        </>
      )}
      <box style={{ height: 1 }} />
      {card.id === "beacon" && status.state === "not_configured" && (
        <>
          <text content="Beacon pages you on Telegram when something needs you. Scripts, cron jobs and" fg={theme.textDim} />
          <text content={'the other modules all send through it: spinuptui beacon send "…".'} fg={theme.textDim} />
          <box style={{ height: 1 }} />
          <text content="Press ⏎ to connect a Telegram bot. It takes about two minutes." fg={theme.accent} />
        </>
      )}
      {card.id === "beacon" && status.state !== "not_configured" && (
        <text content="⏎ reconfigure the pager  ·  t send a test page  ·  CLI: spinuptui beacon status" fg={theme.textFaint} />
      )}
      {card.id === "scheduler" && <SchedulerDetail installed={status.state !== "not_configured"} refreshKey={status} />}
    </box>
  )
}

function SchedulerDetail({ installed, refreshKey }: { installed: boolean; refreshKey: unknown }) {
  const [runs] = useState(() => upcomingRuns())
  // Level 0 of the SpinupTUI folder: always say where the work lands.
  const [home, setHome] = useState<HomeStatus | null>(null)
  useEffect(() => {
    let live = true
    void homeStatus().then((h) => live && setHome(h))
    return () => {
      live = false
    }
  }, [refreshKey])
  return (
    <>
      <box style={{ height: 1 }} />
      {!installed && (
        <>
          <text
            content="Scheduler runs follow-ups on this machine while you're away: queue a check for tomorrow at 8 and the result arrives on your pager. It's also the clock the other modules run on, so turning it on is what makes this machine a station."
            fg={theme.textDim}
          />
          <box style={{ height: 1 }} />
          <text content="Press ⏎ to see exactly what it installs, then confirm." fg={theme.accent} />
          <box style={{ height: 1 }} />
        </>
      )}
      <text content={runs.length ? "Next up:" : "No follow-ups queued."} fg={theme.textDim} />
      {runs.map((r) => (
        <box key={`${r.source}/${r.id}`} style={{ flexDirection: "row" }}>
          <text content={`  ${r.next.padEnd(17)} `} fg={theme.text} wrapMode="none" style={{ flexShrink: 0 }} />
          <text content={`${r.source}/${r.id}`} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
        </box>
      ))}
      <box style={{ height: 1 }} />
      {home && <text content={`Jobs and reports: ${tilde(home.path)}`} fg={theme.textDim} wrapMode="none" />}
      {home && <text content={`  ${describeShare(home)}`} fg={home.git && home.remote ? theme.good : theme.textDim} wrapMode="none" />}
      <text content={home?.git && home.remote ? "f your folder" : "f share it across machines, so you can queue jobs from anywhere"} fg={theme.accent} wrapMode="none" />
      <box style={{ height: 1 }} />
      <text
        content={`${installed ? "⏎ reinstall (repairs the unit)  ·  " : ""}CLI: spinuptui scheduler add | list | status`}
        fg={theme.textFaint}
      />
    </>
  )
}

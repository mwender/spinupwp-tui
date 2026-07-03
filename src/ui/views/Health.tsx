// Live server health view (full-screen overlay).
//
// Opened from the Browser with `h`. Polls the selected server over SSH every
// few seconds and renders a custom dashboard: CPU (aggregate gauge + sparkline
// + per-core), memory/swap, disk mounts, and top processes. Esc/q/h closes it.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme, diskColor } from "../../lib/theme.ts"
import { formatBytes, bar, formatUptime, sparkline, timeAgo, truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, type KumaDomainStatus } from "../store.tsx"
import { fetchServerHealth, type HealthSnapshot } from "../../lib/ssh.ts"

const POLL_MS = 2500

// Color a 0..100 load/usage figure green→amber→red.
function loadColor(load: number, cores: number): string {
  if (load >= cores) return theme.bad
  if (load >= cores * 0.7) return theme.warn
  return theme.good
}

// A labeled horizontal gauge: [label] [bar] [pct] [trailing].
function Gauge({
  label,
  pct,
  color,
  width = 20,
  trailing,
  labelWidth = 8,
}: {
  label: string
  pct: number
  color?: string
  width?: number
  trailing?: string
  labelWidth?: number
}) {
  const c = color ?? diskColor(pct)
  return (
    <box style={{ flexDirection: "row", height: 1 }}>
      <text content={label.padEnd(labelWidth)} fg={theme.textDim} style={{ flexShrink: 0 }} />
      <text content={bar(pct / 100, width)} fg={c} style={{ flexShrink: 0 }} />
      <text content={` ${pct.toFixed(0)}%`.padStart(5)} fg={c} style={{ flexShrink: 0 }} />
      {trailing && <text content={`  ${trailing}`} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />}
    </box>
  )
}

export function Health() {
  const { healthServer, setHealthServer, sitesForServer, sshUser, kumaStatus } = useStore()
  const { height } = useTerminalDimensions()
  const server = healthServer

  const sites = useMemo(() => (server ? sitesForServer(server.id) : []), [server, sitesForServer])

  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState("")
  const [loading, setLoading] = useState(true)
  const [history, setHistory] = useState<number[]>([])
  const busy = useRef(false)

  const poll = useCallback(async () => {
    if (!server || busy.current) return
    busy.current = true
    const res = await fetchServerHealth(server, sites, sshUser)
    busy.current = false
    setTarget(res.target)
    setLoading(false)
    if (res.ok) {
      setSnapshot(res.snapshot)
      setError(null)
      setHistory((h) => [...h, res.snapshot.cpuPct].slice(-120))
    } else {
      setError(res.error)
    }
  }, [server, sites, sshUser])

  // Poll on open and on an interval; reset when the target server changes.
  useEffect(() => {
    setLoading(true)
    setSnapshot(null)
    setError(null)
    setHistory([])
    void poll()
    const id = setInterval(() => void poll(), POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q" || key.name === "h") return setHealthServer(null)
    if (key.name === "r") return void poll()
  })

  if (!server) return null

  const procRows = Math.max(3, Math.min(snapshot?.processes.length ?? 0, height - 18))

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
        zIndex: 200,
      }}
    >
      {/* Title bar */}
      <box
        style={{
          flexDirection: "row",
          height: 1,
          backgroundColor: theme.bgAlt,
          paddingLeft: 1,
          paddingRight: 1,
          alignItems: "center",
        }}
      >
        <text content="⬢ Server Health  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(server.name, 36)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <text content={`  ${target}`} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <box style={{ flexGrow: 1 }} />
        {loading && <Spinner interval={120} />}
        <text
          content={snapshot ? `  updated ${timeAgo(new Date(snapshot.takenAt).toISOString())}` : "  connecting…"}
          fg={theme.textFaint}
          style={{ flexShrink: 0 }}
        />
      </box>

      {loading && !snapshot && !error ? (
        <Centered>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={`  Connecting to ${target || server.ip_address}…`} fg={theme.textDim} />
          </box>
        </Centered>
      ) : error && !snapshot ? (
        <Centered>
          <box
            title=" Couldn't reach this server "
            titleColor={theme.bad}
            border
            borderColor={theme.bad}
            style={{ flexDirection: "column", width: 70, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
          >
            <text content={`✕ ${error}`} fg={theme.bad} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content={`Tried:  ssh ${target}`} fg={theme.textDim} />
            <text content="The health view uses your local SSH keys (no password prompts)." fg={theme.textFaint} />
            <text content={`Verify it works first:  ssh ${target} uptime`} fg={theme.textFaint} />
            <box style={{ height: 1 }} />
            <text content="Press r to retry · Esc to close" fg={theme.textDim} />
          </box>
        </Centered>
      ) : snapshot ? (
        <HealthBody snapshot={snapshot} history={history} server={server} procRows={procRows} staleError={error} kuma={kumaStatus.get(server.name)} />
      ) : null}

      <StatusBar
        hints={[
          { key: "r", label: "refresh now" },
          { key: "esc/q", label: "close" },
        ]}
        message={target ? `live · every ${(POLL_MS / 1000).toFixed(0)}s · ${target}` : undefined}
        showGlobal={false}
      />
    </box>
  )
}

function HealthBody({
  snapshot,
  history,
  server,
  procRows,
  staleError,
  kuma,
}: {
  snapshot: HealthSnapshot
  history: number[]
  server: { name: string }
  procRows: number
  staleError: string | null
  kuma?: KumaDomainStatus
}) {
  const s = snapshot
  const memPct = s.memTotal > 0 ? (s.memUsed / s.memTotal) * 100 : 0
  const swapPct = s.swapTotal > 0 ? (s.swapUsed / s.swapTotal) * 100 : 0

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", padding: 1, gap: 1 }}>
      {/* Top summary row */}
      <box style={{ flexDirection: "row", gap: 1 }}>
        <Summary label="Uptime" value={formatUptime(s.uptimeSecs)} color={theme.text} />
        <Summary label="Load 1m" value={s.load[0].toFixed(2)} color={loadColor(s.load[0], s.cores)} sub={`5m ${s.load[1].toFixed(2)} · 15m ${s.load[2].toFixed(2)}`} />
        <Summary label="CPU" value={`${s.cpuPct.toFixed(0)}%`} color={diskColor(s.cpuPct)} sub={`${s.cores} cores`} />
        <Summary label="Memory" value={`${memPct.toFixed(0)}%`} color={diskColor(memPct)} sub={`${formatBytes(s.memUsed)} / ${formatBytes(s.memTotal)}`} />
      </box>

      <box style={{ flexGrow: 1, flexDirection: "row", gap: 1 }}>
        {/* Left: CPU + memory */}
        <box style={{ flexDirection: "column", flexGrow: 1, gap: 1 }}>
          <Panel title=" CPU " flexGrow={1}>
            <box style={{ flexGrow: 1, flexDirection: "column" }}>
              <Gauge label="all" pct={s.cpuPct} color={diskColor(s.cpuPct)} width={20} labelWidth={6} />
              <box style={{ height: 1 }} />
              <box style={{ flexDirection: "row" }}>
                <text content="history " fg={theme.textDim} style={{ flexShrink: 0 }} />
                <text content={sparkline(history, 40)} fg={theme.brand} wrapMode="none" style={{ flexShrink: 1 }} />
              </box>
              <box style={{ height: 1 }} />
              {s.perCore.map((c) => (
                <Gauge key={c.idx} label={`cpu${c.idx}`} pct={c.pct} color={diskColor(c.pct)} width={16} labelWidth={6} />
              ))}
            </box>
          </Panel>
          <Panel title=" Memory " flexGrow={1}>
            <box style={{ flexGrow: 1, flexDirection: "column" }}>
              <Gauge label="RAM" pct={memPct} color={diskColor(memPct)} width={18} trailing={`${formatBytes(s.memUsed)} / ${formatBytes(s.memTotal)}`} />
              {s.swapTotal > 0 ? (
                <Gauge label="Swap" pct={swapPct} color={diskColor(swapPct)} width={18} trailing={`${formatBytes(s.swapUsed)} / ${formatBytes(s.swapTotal)}`} />
              ) : (
                <box style={{ flexDirection: "row", height: 1 }}>
                  <text content={"Swap".padEnd(8)} fg={theme.textDim} />
                  <text content="none" fg={theme.textFaint} />
                </box>
              )}
              <box style={{ height: 1 }} />
              <text content={`Available  ${formatBytes(s.memAvailable)}`} fg={theme.textFaint} />
            </box>
          </Panel>
        </box>

        {/* Right: disks + processes */}
        <box style={{ flexDirection: "column", flexGrow: 1, gap: 1 }}>
          <Panel title=" Disk ">
            <box style={{ flexDirection: "column" }}>
              {s.disks.length === 0 ? (
                <text content="No mounts reported" fg={theme.textFaint} />
              ) : (
                s.disks.slice(0, 5).map((d) => (
                  <Gauge
                    key={d.mount}
                    label={truncate(d.mount, 10)}
                    pct={d.pct}
                    color={diskColor(d.pct)}
                    width={10}
                    labelWidth={11}
                    trailing={`${formatBytes(d.used)}/${formatBytes(d.total)}`}
                  />
                ))
              )}
            </box>
          </Panel>
          {kuma && (
            <Panel title=" Monitor (Uptime Kuma) ">
              <box style={{ flexDirection: "column" }}>
                <box style={{ flexDirection: "row", height: 1 }}>
                  <text content={kuma.up === false ? "○ down" : kuma.up ? "● up" : "· no beats yet"} fg={kuma.up === false ? theme.bad : kuma.up ? theme.good : theme.textFaint} style={{ flexShrink: 0 }} />
                  {kuma.uptime24 != null && <text content={`   ${(kuma.uptime24 * 100).toFixed(2)}% (24h)`} fg={theme.textDim} wrapMode="none" />}
                </box>
                {kuma.responseBeats.length > 1 && (
                  <box style={{ flexDirection: "row", height: 1 }}>
                    <text content="response " fg={theme.textDim} style={{ flexShrink: 0 }} />
                    <text content={sparkline(kuma.responseBeats.slice(-40), 40)} fg={theme.brand} wrapMode="none" style={{ flexShrink: 1 }} />
                  </box>
                )}
                {kuma.loadBeats.length > 1 && (
                  <box style={{ flexDirection: "row", height: 1 }}>
                    <text content="load     " fg={theme.textDim} style={{ flexShrink: 0 }} />
                    <text content={sparkline(kuma.loadBeats.slice(-40), 40)} fg={theme.accent} wrapMode="none" style={{ flexShrink: 1 }} />
                    {kuma.lastLoad != null && <text content={` ${kuma.lastLoad.toFixed(2)}`} fg={theme.textDim} style={{ flexShrink: 0 }} />}
                  </box>
                )}
              </box>
            </Panel>
          )}
          <Panel title=" Top processes " flexGrow={1}>
            <box style={{ flexGrow: 1, flexDirection: "column" }}>
              <box style={{ flexDirection: "row", height: 1 }}>
                <text content={"PID".padEnd(8)} fg={theme.textFaint} style={{ flexShrink: 0 }} />
                <text content="COMMAND" fg={theme.textFaint} style={{ flexGrow: 1, flexShrink: 1 }} />
                <text content="  CPU%  MEM%" fg={theme.textFaint} style={{ flexShrink: 0 }} />
              </box>
              {s.processes.slice(0, procRows).map((p) => (
                <box key={p.pid} style={{ flexDirection: "row", height: 1 }}>
                  <text content={(p.pid + " ").padEnd(8)} fg={theme.textDim} style={{ flexShrink: 0 }} />
                  <text content={truncate(p.comm, 18)} fg={theme.text} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  <text content={`${p.cpu.toFixed(1)}`.padStart(6)} fg={p.cpu > 50 ? theme.warn : theme.textDim} style={{ flexShrink: 0 }} />
                  <text content={`${p.mem.toFixed(1)}`.padStart(6)} fg={theme.textDim} style={{ flexShrink: 0 }} />
                </box>
              ))}
            </box>
          </Panel>
        </box>
      </box>

      {staleError && <text content={`⚠ last poll failed: ${staleError} — showing previous reading`} fg={theme.warn} wrapMode="none" />}
    </box>
  )
}

function Summary({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }): ReactNode {
  return (
    <box border borderColor={theme.border} style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1, paddingRight: 1, height: 5 }}>
      <text content={label} fg={theme.textDim} />
      <text content={value} fg={color} attributes={1} />
      <text content={sub ?? ""} fg={theme.textFaint} wrapMode="none" />
    </box>
  )
}

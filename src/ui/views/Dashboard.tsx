// Fleet dashboard: at-a-glance health of every server and site in the account.

import { useMemo } from "react"
import { theme, diskColor } from "../../lib/theme.ts"
import { formatBytes, diskUsedPct, bar, truncate, timeAgo } from "../../lib/format.ts"
import { Panel } from "../components.tsx"
import { useStore } from "../store.tsx"
import type { Server } from "../../api/types.ts"

// A single headline metric card. Height 5 = 2 border rows + 3 content lines.
function Stat({ label, value, color = theme.text, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <box
      border
      borderColor={theme.border}
      style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1, paddingRight: 1, height: 5 }}
    >
      <text content={label} fg={theme.textDim} />
      <text content={value} fg={color} attributes={1} />
      <text content={sub ?? ""} fg={theme.textFaint} />
    </box>
  )
}

function serverDiskFraction(s: Server): number {
  return diskUsedPct(s.disk_space?.used, s.disk_space?.total) / 100
}

export function Dashboard({ rows }: { rows: number }) {
  const { servers, sites, events, isServerOsEol } = useStore()

  const agg = useMemo(() => {
    const connected = servers.filter((s) => s.connection_status === "connected").length
    const reboot = servers.filter((s) => s.reboot_required).length
    const upgrade = servers.filter((s) => s.upgrade_required).length
    let used = 0
    let total = 0
    for (const s of servers) {
      if (s.disk_space) {
        used += s.disk_space.used || 0
        total += s.disk_space.total || 0
      }
    }
    const wp = sites.filter((s) => s.is_wordpress).length
    const pluginUpd = sites.reduce((n, s) => n + (s.wp_plugin_updates || 0), 0)
    const themeUpd = sites.reduce((n, s) => n + (s.wp_theme_updates || 0), 0)
    const coreUpd = sites.filter((s) => s.wp_core_update).length
    const https = sites.filter((s) => s.https?.enabled).length
    return { connected, reboot, upgrade, used, total, wp, pluginUpd, themeUpd, coreUpd, https }
  }, [servers, sites])

  // Servers sorted by disk pressure (busiest first) for the watchlist.
  const byDisk = useMemo(
    () => [...servers].sort((a, b) => serverDiskFraction(b) - serverDiskFraction(a)),
    [servers],
  )

  // Things that want attention: reboots, upgrades, pending WP updates.
  const attention = useMemo(() => {
    const items: { text: string; color: string }[] = []
    for (const s of servers) {
      if (s.reboot_required) items.push({ text: `${s.name} — reboot required`, color: theme.warn })
      if (s.upgrade_required) items.push({ text: `${s.name} — SpinupWP upgrade required`, color: theme.warn })
      if (isServerOsEol(s)) items.push({ text: `${s.name} — Ubuntu ${s.ubuntu_version} is EOL, clone to a newer server`, color: theme.bad })
    }
    return items
  }, [servers, isServerOsEol])

  const diskPct = agg.total > 0 ? (agg.used / agg.total) * 100 : 0
  const listRows = Math.max(3, rows - 9) // minus the stat-card band (5), status bar, and panel chrome

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
      {/* Headline metrics */}
      <box style={{ flexDirection: "row", gap: 1 }}>
        <Stat label="Servers" value={String(servers.length)} color={theme.brand} sub={`${agg.connected} connected`} />
        <Stat label="Sites" value={String(sites.length)} color={theme.accent} sub={`${agg.wp} WordPress`} />
        <Stat
          label="Fleet Disk"
          value={`${diskPct.toFixed(0)}%`}
          color={diskColor(diskPct)}
          sub={`${formatBytes(agg.used)} / ${formatBytes(agg.total)}`}
        />
        <Stat
          label="WP Updates"
          value={String(agg.pluginUpd + agg.themeUpd + agg.coreUpd)}
          color={agg.pluginUpd + agg.themeUpd + agg.coreUpd > 0 ? theme.warn : theme.good}
          sub={`${agg.pluginUpd} plugin · ${agg.coreUpd} core`}
        />
        <Stat
          label="Maintenance"
          value={String(agg.reboot + agg.upgrade)}
          color={agg.reboot + agg.upgrade > 0 ? theme.warn : theme.good}
          sub={`${agg.reboot} reboot · ${agg.upgrade} upgrade`}
        />
      </box>

      {/* Two columns: disk watchlist + attention/activity */}
      <box style={{ flexGrow: 1, flexDirection: "row", gap: 1, marginTop: 1 }}>
        <Panel title=" Disk usage by server " flexGrow={1}>
          <box style={{ flexGrow: 1, flexDirection: "column" }}>
            {byDisk.slice(0, listRows).map((s) => {
              const frac = serverDiskFraction(s)
              const pct = frac * 100
              return (
                <box key={s.id} style={{ flexDirection: "row", height: 1 }}>
                  <text content={truncate(s.name, 30)} fg={theme.text} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  <text content={bar(frac, 10)} fg={diskColor(pct)} style={{ flexShrink: 0 }} />
                  <text content={` ${pct.toFixed(0)}%`.padStart(5)} fg={diskColor(pct)} style={{ flexShrink: 0 }} />
                  <text content={s.disk_space ? `  ${formatBytes(s.disk_space.used)}` : "  —"} fg={theme.textDim} style={{ flexShrink: 0 }} />
                </box>
              )
            })}
          </box>
        </Panel>

        <box style={{ flexDirection: "column", flexGrow: 1, gap: 1 }}>
          <Panel title={` Needs attention (${attention.length}) `} flexGrow={1}>
            <box style={{ flexGrow: 1, flexDirection: "column" }}>
              {attention.length === 0 ? (
                <text content="✓ All servers healthy" fg={theme.good} />
              ) : (
                attention.slice(0, Math.max(1, Math.floor(listRows / 2))).map((a, i) => (
                  <box key={i} style={{ flexDirection: "row", height: 1 }}>
                    <text content={`• ${truncate(a.text, 60)}`} fg={a.color} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  </box>
                ))
              )}
            </box>
          </Panel>
          <Panel title=" Recent activity " flexGrow={1}>
            <box style={{ flexGrow: 1, flexDirection: "column" }}>
              {events.length === 0 ? (
                <text content="No recent events" fg={theme.textFaint} />
              ) : (
                events.slice(0, Math.max(1, Math.floor(listRows / 2))).map((e) => (
                  <box key={e.id} style={{ flexDirection: "row", height: 1 }}>
                    <text content={truncate(e.name, 44)} fg={theme.text} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                    <text content={" " + timeAgo(e.created_at)} fg={theme.textFaint} style={{ flexShrink: 0 }} />
                  </box>
                ))
              )}
            </box>
          </Panel>
        </box>
      </box>
    </box>
  )
}

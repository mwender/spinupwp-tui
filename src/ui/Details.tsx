// Detail panels for a server and a site. Shared by the Browser and Search views.

import { theme, statusColor, diskColor } from "../lib/theme.ts"
import { formatBytes, diskUsedPct, bar, formatDate, timeAgo, truncate } from "../lib/format.ts"
import { Field, StatusBadge } from "./components.tsx"
import { classifyStack, stackColor } from "../lib/stack.ts"
import { probeKindColor } from "../lib/probe.ts"
import { useStore, isUpgradeInFlight } from "./store.tsx"
import type { Server, Site } from "../api/types.ts"

export function ServerDetail({ server, siteCount }: { server: Server; siteCount: number }) {
  const ds = server.disk_space
  const pct = diskUsedPct(ds?.used, ds?.total)
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <text content={truncate(server.name, 34)} fg={theme.text} attributes={1} />
        <box style={{ flexGrow: 1 }} />
        <StatusBadge status={server.connection_status} />
      </box>
      <text content={server.ip_address ?? "—"} fg={theme.accent} />
      <box style={{ height: 1 }} />

      <Field label="Provider" value={server.provider_name ?? "—"} />
      <Field label="Region" value={server.region ?? "—"} />
      <Field label="Size" value={server.size ?? "—"} />
      <Field label="Ubuntu" value={server.ubuntu_version ?? "—"} />
      <Field label="SSH" value={`${server.ip_address ?? "—"}:${server.ssh_port ?? 22}`} />
      <Field label="Database" value={server.database?.server ?? "—"} />
      <Field label="Sites" value={String(siteCount)} valueColor={theme.accent} />
      <box style={{ height: 1 }} />

      <Field
        label="Disk"
        value={
          <box style={{ flexDirection: "row" }}>
            <text content={bar(pct / 100, 16)} fg={diskColor(pct)} />
            <text content={` ${pct.toFixed(0)}%`} fg={diskColor(pct)} />
          </box>
        }
      />
      <Field label="Used / Total" value={`${formatBytes(ds?.used)} / ${formatBytes(ds?.total)}`} />
      <Field label="Available" value={formatBytes(ds?.available)} />
      <box style={{ height: 1 }} />

      <Field
        label="Reboot"
        value={server.reboot_required ? "required" : "not needed"}
        valueColor={server.reboot_required ? theme.warn : theme.good}
      />
      <Field
        label="SpinupWP upgrade"
        value={server.upgrade_required ? "required — press w to open" : "up to date"}
        valueColor={server.upgrade_required ? theme.warn : theme.good}
      />
      <Field label="Created" value={formatDate(server.created_at)} />
    </box>
  )
}

export function SiteDetail({ site, serverName }: { site: Site; serverName: string }) {
  const { probes, probingIds, isProbeStale, phpUpgrades } = useStore()
  const updates = (site.wp_plugin_updates || 0) + (site.wp_theme_updates || 0) + (site.wp_core_update ? 1 : 0)
  const stack = classifyStack(site)
  const probe = probes.get(site.id)
  const probing = probingIds.has(site.id)
  const upgrade = phpUpgrades.get(site.id)
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <text content={truncate(site.domain, 34)} fg={theme.text} attributes={1} />
        <box style={{ flexGrow: 1 }} />
        <StatusBadge status={site.status} />
      </box>
      <text content={(site.https?.enabled ? "https://" : "http://") + site.domain} fg={theme.accent} />
      <box style={{ height: 1 }} />

      <Field label="Server" value={truncate(serverName, 30)} />
      <Field label="Stack" value={stack} valueColor={stackColor(stack)} />
      <Field
        label="Detected"
        value={probing ? "probing…" : probe ? probe.result.label + (isProbeStale(site) ? " (stale)" : "") : "not probed · d"}
        valueColor={probing ? theme.textDim : probe ? probeKindColor(probe.result.kind) : theme.textFaint}
      />
      <Field label="Type" value={site.is_wordpress ? "WordPress" : "Generic"} valueColor={site.is_wordpress ? theme.brand : theme.textDim} />
      <Field
        label="PHP"
        value={
          upgrade && isUpgradeInFlight(upgrade)
            ? `${site.php_version ?? "—"} → ${upgrade.target} (${upgrade.status}…)`
            : upgrade?.status === "failed"
              ? `${site.php_version ?? "—"} (upgrade failed)`
              : (site.php_version ?? "—")
        }
        valueColor={
          upgrade && isUpgradeInFlight(upgrade) ? theme.warn : upgrade?.status === "failed" ? theme.bad : theme.text
        }
      />
      <Field label="User" value={site.site_user ?? "—"} />
      <Field label="Public dir" value={site.public_folder ?? "/"} />
      <Field
        label="HTTPS"
        value={site.https?.enabled ? "enabled" : "disabled"}
        valueColor={site.https?.enabled ? theme.good : theme.warn}
      />
      <Field
        label="Page cache"
        value={site.page_cache?.enabled ? "enabled" : "disabled"}
        valueColor={site.page_cache?.enabled ? theme.good : theme.textDim}
      />
      <box style={{ height: 1 }} />

      {site.is_wordpress && (
        <Field
          label="WP updates"
          value={
            updates === 0
              ? "all up to date"
              : `${site.wp_plugin_updates || 0} plugin · ${site.wp_theme_updates || 0} theme${site.wp_core_update ? " · core" : ""}`
          }
          valueColor={updates === 0 ? theme.good : theme.warn}
        />
      )}
      <Field
        label="Backups"
        value={
          site.backups?.files || site.backups?.database
            ? `${site.backups?.files ? "files" : ""}${site.backups?.files && site.backups?.database ? " + " : ""}${site.backups?.database ? "db" : ""}`
            : "none"
        }
        valueColor={site.backups?.files || site.backups?.database ? theme.good : theme.textDim}
      />
      {site.backups?.next_run_time && <Field label="Next backup" value={timeAgo(site.backups.next_run_time)} />}
      {site.git?.repo && <Field label="Git" value={`${truncate(site.git.repo, 26)} (${site.git.branch ?? "?"})`} />}
      {site.basic_auth?.enabled && <Field label="Basic auth" value="enabled" valueColor={theme.warn} />}
      <Field label="Created" value={formatDate(site.created_at)} />
    </box>
  )
}

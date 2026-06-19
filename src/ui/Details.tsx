// Detail panels for a server and a site. Shared by the Browser and Search views.

import { useEffect } from "react"
import { theme, statusColor, diskColor } from "../lib/theme.ts"
import { formatBytes, diskUsedPct, bar, formatDate, timeAgo, truncate } from "../lib/format.ts"
import { Field, StatusBadge } from "./components.tsx"
import { classifyStack, stackColor } from "../lib/stack.ts"
import { probeKindColor } from "../lib/probe.ts"
import { resolveLocalLink } from "../lib/local.ts"
import type { Drift } from "../lib/gitStatus.ts"
import { useStore, isUpgradeInFlight, isServerOpInFlight } from "./store.tsx"
import type { Server, Site } from "../api/types.ts"

export function ServerDetail({ server, siteCount }: { server: Server; siteCount: number }) {
  const { rebootInfo, serverOps } = useStore()
  const ds = server.disk_space
  const pct = diskUsedPct(ds?.used, ds?.total)
  const op = serverOps.get(server.id)
  const rb = rebootInfo.get(server.id)
  const rebootValue =
    op && isServerOpInFlight(op)
      ? `${op.label}…`
      : op?.status === "failed"
        ? "action failed"
        : server.reboot_required
          ? rb?.present
            ? `required · ${rb.kernel ? "kernel update" : "pkg updates"} (${rb.packages.length})`
            : "required"
          : "not needed"
  const rebootColor =
    op?.status === "failed" ? theme.bad : server.reboot_required || (op && isServerOpInFlight(op)) ? theme.warn : theme.good
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

      <Field label="Reboot" value={rebootValue} valueColor={rebootColor} />
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
  const { probes, probingIds, isProbeStale, phpUpgrades, localLinks } = useStore()
  const updates = (site.wp_plugin_updates || 0) + (site.wp_theme_updates || 0) + (site.wp_core_update ? 1 : 0)
  const stack = classifyStack(site)
  const probe = probes.get(site.id)
  const probing = probingIds.has(site.id)
  const upgrade = phpUpgrades.get(site.id)
  const link = localLinks.get(site.id)
  const linkState = link ? resolveLocalLink(link) : null
  const linkValue = !link
    ? "not linked · L"
    : !linkState!.exists
      ? "missing — path not found"
      : `${linkState!.label} · ${link.path}`
  const linkColor = !link ? theme.textFaint : !linkState!.exists ? theme.bad : theme.good
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
        value={probing ? "identifying…" : probe ? probe.result.label + (isProbeStale(site) ? " (stale)" : "") : "not identified · d"}
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
      <Field label="Local" value={linkValue} valueColor={linkColor} />
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

// Color for a resolved local stack label.
function localLabelColor(kind: "bedrock" | "wp" | "unknown"): string {
  return kind === "bedrock" ? theme.good : kind === "wp" ? theme.accent : theme.warn
}

// Compact, self-explaining git-drift label for a linked copy's line, e.g.
// "⇡2 unpushed  ● uncommitted". Empty when in sync.
function driftLabel(d: Drift): string {
  const parts: string[] = []
  if (d.ahead > 0) parts.push(`⇡${d.ahead} unpushed`)
  if (d.dirty) parts.push("● uncommitted")
  return parts.join("  ")
}

// A single inline action token, e.g. "t terminal". Dimmed when not applicable.
function Act({ keyName, label, on }: { keyName: string; label: string; on: boolean }) {
  return (
    <box style={{ flexDirection: "row", flexShrink: 0, marginRight: 3 }}>
      <text content={keyName + " "} fg={on ? theme.brand : theme.textFaint} />
      <text content={label} fg={on ? theme.textDim : theme.textFaint} wrapMode="none" />
    </box>
  )
}

// Height (incl. border) of the contextual strip — views subtract this from their
// list viewport so the panes shrink to make room. Border eats 2 rows → 2 content
// lines (status + actions).
export const SITE_CONTEXT_STRIP_HEIGHT = 4

// A full-width context strip for the selected site, sitting between the content
// panes and the command drawer. Shows the local-link status and the inline
// open-locally actions (which the host view's keyboard fires on the selection).
// The space is always reserved (a placeholder when nothing is selected) so the
// layout doesn't jump as the cursor moves.
export function SiteContextStrip({ site }: { site: Site | null }) {
  const { localLinks, drift, ensureDrift } = useStore()
  const link = site ? localLinks.get(site.id) : undefined
  const state = link ? resolveLocalLink(link) : null
  const canOpen = !!state?.exists
  const hasLocalUrl = !!link?.localUrl
  const d = site ? drift.get(site.id) : undefined

  // Auto-compute (and cache) git drift when a linked, on-disk copy is shown.
  useEffect(() => {
    if (site && link && state?.exists) ensureDrift(site.id, link.path)
  }, [site?.id, link?.path, state?.exists, ensureDrift])

  return (
    <box
      title=" Local "
      titleColor={theme.brand}
      border
      borderColor={link && !state!.exists ? theme.bad : theme.border}
      style={{ height: SITE_CONTEXT_STRIP_HEIGHT, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}
    >
      {/* Line 1 — status (or, with nothing selected, a legend for the row markers) */}
      {!site ? (
        <box style={{ flexDirection: "row" }}>
          <text content="◆ " fg={theme.good} style={{ flexShrink: 0 }} />
          <text content="linked locally    " fg={theme.textDim} style={{ flexShrink: 0 }} />
          <text content="↑N " fg={theme.warn} style={{ flexShrink: 0 }} />
          <text content="pending WordPress updates" fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
        </box>
      ) : !link ? (
        <box style={{ flexDirection: "row" }}>
          <text content={truncate(site.domain, 44)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
          <text content="  not linked" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        </box>
      ) : !state!.exists ? (
        <box style={{ flexDirection: "row" }}>
          <text content="missing  " fg={theme.bad} style={{ flexShrink: 0 }} />
          <text content={link.path} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
        </box>
      ) : (
        <box style={{ flexDirection: "row" }}>
          <text content={state!.label} fg={localLabelColor(state!.kind)} style={{ flexShrink: 0 }} />
          <text content="  ·  " fg={theme.textFaint} style={{ flexShrink: 0 }} />
          <text content={link.path} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
          {link.localUrl ? (
            <text content={"   " + link.localUrl} fg={theme.accent} wrapMode="none" style={{ flexShrink: 1 }} />
          ) : null}
          {d && (d.ahead > 0 || d.dirty) ? (
            <text content={"   " + driftLabel(d)} fg={theme.warn} wrapMode="none" style={{ flexShrink: 0 }} />
          ) : null}
        </box>
      )}

      {/* Line 2 — inline actions (fired by the host view on the selection) */}
      {site ? (
        <box style={{ flexDirection: "row" }}>
          <Act keyName="t" label="terminal" on={canOpen} />
          <Act keyName="v" label="local URL" on={canOpen && hasLocalUrl} />
          <Act keyName="L" label={link ? "edit / unlink" : "link a local copy"} on />
        </box>
      ) : (
        <text content="Select a site to link a local copy and open it locally (t · v · L)" fg={theme.textFaint} wrapMode="none" />
      )}
    </box>
  )
}

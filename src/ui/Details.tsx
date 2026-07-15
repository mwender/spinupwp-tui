// Detail panels for a server and a site. Shared by the Browser and Search views.

import { useEffect } from "react"
import { theme, statusColor, diskColor } from "../lib/theme.ts"
import { formatBytes, diskUsedPct, bar, formatDate, timeAgo, truncate } from "../lib/format.ts"
import { Field, StatusBadge, ControlPanel, siteGroups, type ActionGroup } from "./components.tsx"
import { effectiveStack, stackColor } from "../lib/stack.ts"
import { probeKindColor } from "../lib/probe.ts"
import { resolveLocalLink, type LocalLink, type LocalKind } from "../lib/local.ts"
import { normalizeDomain } from "../lib/dns.ts"
import { isVanityPair } from "../lib/vanitySite.ts"
import type { Drift } from "../lib/gitStatus.ts"
import { useStore, isUpgradeInFlight, isServerOpInFlight, isHttpsToggleInFlight, isPurgeCacheInFlight, purgeCacheFailed } from "./store.tsx"
import type { Server, Site } from "../api/types.ts"

export function ServerDetail({ server, siteCount }: { server: Server; siteCount: number }) {
  const { rebootInfo, serverOps, isServerOsEol } = useStore()
  const ds = server.disk_space
  const pct = diskUsedPct(ds?.used, ds?.total)
  const op = serverOps.get(server.id)
  const rb = rebootInfo.get(server.id)
  const osEol = isServerOsEol(server)
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
      <Field
        label="Ubuntu"
        value={osEol ? `${server.ubuntu_version} — EOL, clone to newer (C)` : (server.ubuntu_version ?? "—")}
        valueColor={osEol ? theme.bad : undefined}
      />
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

// Server Control groups, rendered by the Browser's bottom ControlStrip (layout
// "flow") or Search's Actions pane (layout "list", the default). Search's
// query-focus Details still shows ServerDetail without this.
export function ServerControl({ server, layout }: { server: Server; layout?: "list" | "flow" }) {
  const { vanityJob, sitesForServer } = useStore()
  return <ControlPanel heading="Server Control" groups={serverControlGroups(server, vanityJob, sitesForServer)} layout={layout} />
}

// The static groups, plus a Manage "V" row whenever the V key would actually do
// something: the server has no site at its own hostname yet (busy servers
// benefit from a vanity site just like empty ones), or an unfinished build for
// this server can be reopened.
function serverControlGroups(
  server: Server,
  vanityJob: ReturnType<typeof useStore>["vanityJob"],
  sitesForServer: ReturnType<typeof useStore>["sitesForServer"],
): ActionGroup[] {
  const resumable = vanityJob != null && vanityJob.step !== "done" && vanityJob.serverId === server.id
  const hasVanity = sitesForServer(server.id).some((s) => s.domain.toLowerCase() === server.name.toLowerCase())
  if (!resumable && hasVanity) return SERVER_CONTROL
  const vanityItem: [string, string] = ["V", resumable ? "Resume vanity build" : "Vanity at hostname"]
  return SERVER_CONTROL.map((g) => (g.title === "Manage" ? { ...g, items: [...g.items, vanityItem] } : g))
}

// Labels stay terse and avoid repeating their group's title — see siteGroups().
export const SERVER_CONTROL: ActionGroup[] = [
  { title: "Clone", items: [["C", "Clone →"]] },
  { title: "Access", items: [["S", "Sudo"], ["K", "Grant SSH key"]] },
  {
    title: "Manage",
    items: [
      ["a", "Reboot / restart"],
      ["h", "Health"],
      ["N", "DNS"],
    ],
  },
  { title: "Open", items: [["w", "In SpinupWP"]] },
]

export function SiteDetail({ site, serverName }: { site: Site; serverName: string }) {
  const { probes, probingIds, isProbeStale, phpUpgrades, httpsToggles, purgeCacheProgress, localLinks, grantedKeyKinds, kumaStatus, kumaMonitorFor, kumaOps, localSync } = useStore()
  const isVanity = isVanityPair(site.domain, serverName)
  const reseedOp = kumaOps.get(site.id)
  const kuma = kumaStatus.get(site.domain)
  // The fingerprint check failing while HTTP is up means the site is answering
  // 200 with the WRONG page (stale/corrupt page cache) — a distinct, worse state
  // than down, so it outranks the plain up/down wording.
  const kumaValue = kuma
    ? kuma.up === false
      ? "DOWN"
      : kuma.fingerprintUp === false
        ? "up · WRONG PAGE SERVED (M)"
        : kuma.redisUp === false
          ? "up · REDIS DOWN (M)"
          : kuma.up
            ? `up${kuma.uptime24 != null ? ` · ${(kuma.uptime24 * 100).toFixed(2)}% (24h)` : ""}`
            : "no beats yet"
    : kumaMonitorFor(site.domain)
      ? "registered · awaiting poll"
      : "not monitored · M"
  const kumaColor = kuma ? (kuma.up === false || kuma.fingerprintUp === false || kuma.redisUp === false ? theme.bad : kuma.up ? theme.good : theme.textDim) : theme.textFaint
  const httpsProgress = httpsToggles.get(site.id)
  const purgeProgress = purgeCacheProgress.get(site.id)
  const updates = (site.wp_plugin_updates || 0) + (site.wp_theme_updates || 0) + (site.wp_core_update ? 1 : 0)
  const probe = probes.get(site.id)
  // Prefer the DETECTED stack over SpinupWP's is_wordpress/git shape, which
  // misclassifies some sites (a /public/ WP install shows as "Generic", Bedrock
  // git sites report is_wordpress:false). Falls back to the API when unprobed.
  const stack = effectiveStack(site, probe?.result.kind)
  const isWordPress = stack !== "Non-WP"
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
  // SSH keys Spinup has granted into this site user's authorized_keys, split into
  // your personal key(s) vs the spinup-tui machine key (so it's never ambiguous).
  const keyKinds = grantedKeyKinds(site.id)
  const keyParts: string[] = []
  if (keyKinds.personal > 0) keyParts.push(keyKinds.personal > 1 ? `your keys (${keyKinds.personal})` : "your key")
  if (keyKinds.machine > 0) keyParts.push("spinup-tui")
  const keyValue = keyParts.length ? `${keyParts.join(" + ")} · K` : "not granted · K"
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
      <Field label="Type" value={isWordPress ? "WordPress" : "Generic"} valueColor={isWordPress ? theme.brand : theme.textDim} />
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
      <Field label="Granted" value={keyValue} valueColor={keyParts.length ? theme.good : theme.textFaint} />
      <Field label="Public dir" value={site.public_folder ?? "/"} />
      <Field label="Monitor" value={kumaValue} valueColor={kumaColor} />
      {isVanity && reseedOp?.status === "running" && <Field label="Refresh" value="publishing…" valueColor={theme.warn} />}
      {isVanity && reseedOp?.status === "error" && <Field label="Refresh" value={`failed: ${reseedOp.error ?? "unknown error"}`} valueColor={theme.bad} />}
      <Field label="Local" value={linkValue} valueColor={linkColor} />
      <SiteDnsSection site={site} />
      <Field
        label="HTTPS"
        value={
          httpsProgress && isHttpsToggleInFlight(httpsProgress)
            ? `${httpsProgress.action === "enable" ? "enabling" : "disabling"}… (${httpsProgress.status})`
            : httpsProgress?.status === "failed"
              ? `${site.https?.enabled ? "enabled" : "disabled"} (toggle failed)`
              : `${site.https?.enabled ? "enabled" : "disabled"} · H`
        }
        valueColor={
          httpsProgress && isHttpsToggleInFlight(httpsProgress)
            ? theme.warn
            : httpsProgress?.status === "failed"
              ? theme.bad
              : site.https?.enabled
                ? theme.good
                : theme.warn
        }
      />
      <Field
        label="Page cache"
        value={
          purgeProgress && isPurgeCacheInFlight(purgeProgress)
            ? "purging…"
            : purgeProgress && purgeCacheFailed(purgeProgress)
              ? `${site.page_cache?.enabled ? "enabled" : "disabled"} (purge failed)`
              : `${site.page_cache?.enabled ? "enabled" : "disabled"} · P purge`
        }
        valueColor={
          purgeProgress && isPurgeCacheInFlight(purgeProgress)
            ? theme.warn
            : purgeProgress && purgeCacheFailed(purgeProgress)
              ? theme.bad
              : site.page_cache?.enabled
                ? theme.good
                : theme.textDim
        }
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

// Site Control groups — see ServerControl above. Recomputes stack/vanity
// itself since it's not a child of SiteDetail; both derivations are cheap.
export function SiteControl({ site, serverName, layout }: { site: Site; serverName: string; layout?: "list" | "flow" }) {
  const { probes } = useStore()
  const stack = effectiveStack(site, probes.get(site.id)?.result.kind)
  const isWordPress = stack !== "Non-WP"
  const isVanity = isVanityPair(site.domain, serverName)
  return <ControlPanel heading="Site Control" groups={siteGroups(isWordPress, isVanity)} layout={layout} />
}

// DNS zone-host lines for a site's domains, populated on demand (key `n`). Each
// distinct zone (www + apex collapsed) shows its resolved host; a separate-TLD
// additional domain surfaces as its own line with its own host. Read-only.
function SiteDnsSection({ site }: { site: Site }) {
  const { zoneForDomain, isDnsResolving } = useStore()
  const seen = new Set<string>()
  const domains = [site.domain, ...(site.additional_domains?.map((a) => a.domain) ?? [])].filter((d) => {
    const k = normalizeDomain(d)
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
  const anyResolved = domains.some((d) => zoneForDomain(d))
  const anyResolving = domains.some((d) => isDnsResolving(d))
  if (!anyResolved && !anyResolving) {
    return <Field label="DNS" value="not checked · n" valueColor={theme.textFaint} />
  }
  return (
    <box style={{ flexDirection: "column" }}>
      <text content="DNS" fg={theme.textDim} />
      {domains.map((d) => {
        const c = zoneForDomain(d)
        const resolving = isDnsResolving(d) && !c
        const host = resolving ? "looking up…" : !c ? "—" : c.zone === null ? "no host found" : c.zone.providerLabel
        const color = resolving ? theme.textDim : !c ? theme.textFaint : c.zone === null ? theme.warn : theme.accent
        return (
          <box key={d} style={{ flexDirection: "row" }}>
            <text content={"  " + truncate(d, 22)} fg={theme.text} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
            <text content={host} fg={color} wrapMode="none" style={{ flexShrink: 0 }} />
          </box>
        )
      })}
    </box>
  )
}

// Color for a resolved local stack label.
function localLabelColor(kind: LocalKind): string {
  switch (kind) {
    case "bedrock":
      return theme.good
    case "radicle":
      return theme.purple
    case "wp":
      return theme.accent
    case "unknown":
      return theme.warn
  }
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

// Shared status line: the selected site's local-link state (not linked / missing
// / linked, with path + local URL + git drift). Used by both SiteContextStrip
// (Stacks — status + inline t/v/L only) and ControlStrip (Browser — status +
// the full action-group list) so the two don't drift apart.
function siteLinkStatusLine(site: Site, link: LocalLink | undefined, state: ReturnType<typeof resolveLocalLink> | null, d: Drift | null | undefined) {
  if (!link) {
    return (
      <box style={{ flexDirection: "row" }}>
        <text content={truncate(site.domain, 44)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <text content="  not linked" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      </box>
    )
  }
  if (!state!.exists) {
    return (
      <box style={{ flexDirection: "row" }}>
        <text content="missing  " fg={theme.bad} style={{ flexShrink: 0 }} />
        <text content={link.path} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>
    )
  }
  return (
    <box style={{ flexDirection: "row" }}>
      <text content={state!.label} fg={localLabelColor(state!.kind)} style={{ flexShrink: 0 }} />
      <text content="  ·  " fg={theme.textFaint} style={{ flexShrink: 0 }} />
      <text content={link.path} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      {link.localUrl ? <text content={"   " + link.localUrl} fg={theme.accent} wrapMode="none" style={{ flexShrink: 1 }} /> : null}
      {d && (d.ahead > 0 || d.dirty) ? <text content={"   " + driftLabel(d)} fg={theme.warn} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
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
//
// Used by views (Stacks) whose keyboard handler only implements a subset of
// siteGroups()'s keys — ControlStrip below, which advertises the FULL action
// list, would be misleading there (hints for keys that don't actually fire).
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
      ) : (
        siteLinkStatusLine(site, link, state, d)
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

// Height (incl. border) of the bottom control strip — views subtract this from
// their list viewport so the panes shrink to make room. `ControlPanel`'s
// layout="flow" skips its own heading (the strip's box title already says
// "Site Control"/"Server Control") and puts each group's title in its own
// column rather than its own line — both to keep this budget small even
// though every group also gets a 1-row marginBottom for breathing room.
// Sized for the worst realistic case (a WP + local-sync + vanity site — 5
// groups: Open/Remote/Local/Vanity/Server, each ≤1 line of items given how
// terse the labels are + its trailing blank row): 2 border + 1 status + 1
// spacer + 5 groups × 2 (content + blank). A lighter site/server just leaves
// blank rows — fixed and generous beats measuring actual wrapped height,
// which would need a measure-then-rerender pass this app has no precedent for.
export const CONTROL_STRIP_HEIGHT = 14

// A full-width strip below the three panes (Browser's Servers tab only — see
// the SiteContextStrip note above for why) showing whichever action list
// applies to what's focused: the selected site's Site Control (status line +
// Open/Remote/Local/Vanity/Server, `layout="flow"`) or, with focus on the
// Servers pane, the selected server's Server Control (status line + Clone/
// Access/Manage/Open). The space is always reserved (a placeholder when
// nothing is selected) so the layout doesn't jump as the cursor moves.
export function ControlStrip({ site, server, serverName }: { site: Site | null; server: Server | null; serverName: string }) {
  const { localLinks, drift, ensureDrift } = useStore()
  const link = site ? localLinks.get(site.id) : undefined
  const state = link ? resolveLocalLink(link) : null
  const d = site ? drift.get(site.id) : undefined

  // Auto-compute (and cache) git drift when a linked, on-disk copy is shown.
  useEffect(() => {
    if (site && link && state?.exists) ensureDrift(site.id, link.path)
  }, [site?.id, link?.path, state?.exists, ensureDrift])

  return (
    <box
      title={site ? " Site Control " : server ? " Server Control " : " Control "}
      titleColor={theme.brand}
      border
      borderColor={link && !state!.exists ? theme.bad : theme.border}
      style={{ height: CONTROL_STRIP_HEIGHT, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}
    >
      {/* Status line */}
      {site ? (
        siteLinkStatusLine(site, link, state, d)
      ) : server ? (
        <box style={{ flexDirection: "row" }}>
          <text content={truncate(server.name, 44)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
          <text content={"  " + (server.ip_address ?? "—")} fg={theme.accent} wrapMode="none" style={{ flexShrink: 0 }} />
          <text content={"  · " + server.connection_status} fg={statusColor(server.connection_status)} wrapMode="none" style={{ flexShrink: 0 }} />
        </box>
      ) : (
        <text content="Select a server or site to see what you can do with it" fg={theme.textFaint} wrapMode="none" />
      )}
      <box style={{ height: 1 }} />

      {/* Action groups */}
      {site ? (
        <SiteControl site={site} serverName={serverName} layout="flow" />
      ) : server ? (
        <ServerControl server={server} layout="flow" />
      ) : null}
    </box>
  )
}

// Fleet composition: site stacks + PHP version spread, with Tier-2 probing.
//
// Left pane: selectable composition groups. The three top-level buckets
// (Standard WP / Bedrock / Non-WP) use the EFFECTIVE stack — a conclusive Tier-2
// probe overrides the API heuristic — so counts drift toward reality as you
// probe. Non-WP expands into named sub-rows (WHMCS / Laravel / Static HTML /
// Unknown / unprobed) from cached probes.
//
// Middle pane: the sites in the selected group. `d` probes the selected site;
// `D` probes the whole selected group (bounded concurrency). Right pane: the
// fleet-wide PHP version distribution with EOL versions flagged.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme, statusColor, statusDot } from "../../lib/theme.ts"
import { bar, truncate } from "../../lib/format.ts"
import { STACKS, effectiveStack, stackColor, type Stack } from "../../lib/stack.ts"
import { phpSortKey } from "../../lib/phpEol.ts"
import { probeKindColor, type ProbeKind } from "../../lib/probe.ts"
import { Panel, Spinner, PhpVersionCell } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { openUrl } from "../../lib/open.ts"
import { siteWebUrl } from "../../lib/spinupweb.ts"
import { useStore } from "../store.tsx"
import type { Site } from "../../api/types.ts"

type Focus = "groups" | "sites"

// A selectable row in the composition pane: a top-level bucket (level 0) or a
// Non-WP sub-category (level 1).
interface Group {
  id: string
  label: string
  level: 0 | 1
  color: string
  sites: Site[]
}

// Non-WP sub-categories, in display order. `kind: null` = not yet probed.
const NONWP_SUBS: { kind: ProbeKind | null; label: string }[] = [
  { kind: "whmcs", label: "WHMCS" },
  { kind: "laravel", label: "Laravel" },
  { kind: "static", label: "Static HTML" },
  { kind: "unknown", label: "Unknown" },
  { kind: null, label: "unprobed" },
]

export function Stacks({ rows }: { rows: number }) {
  const store = useStore()
  const { sites, serverById, route, inputMode, overlayOpen, probes, probingIds, probeErrors, runProbe, runProbeMany, isProbeStale, isPhpEol, accountSlug, setPhpUpgradeSite, phpUpgrades } =
    store

  const [groupIndex, setGroupIndex] = useState(0)
  const [siteIndex, setSiteIndex] = useState(0)
  const [focus, setFocus] = useState<Focus>("groups")
  const [flash, setFlash] = useState<string | null>(null)

  const flashMsg = (m: string) => {
    setFlash(m)
    setTimeout(() => setFlash(null), 1500)
  }

  // Bucket every site by EFFECTIVE stack (probe overrides Tier-1), build the
  // selectable groups (with Non-WP sub-rows), and the fleet PHP histogram.
  const { groups, php } = useMemo(() => {
    const byStack = new Map<Stack, Site[]>(STACKS.map((s) => [s, []]))
    const phpCounts = new Map<string, number>()
    for (const site of sites) {
      const st = effectiveStack(site, probes.get(site.id)?.result.kind)
      byStack.get(st)!.push(site)
      const v = site.php_version ?? "—"
      phpCounts.set(v, (phpCounts.get(v) ?? 0) + 1)
    }
    for (const list of byStack.values()) list.sort((a, b) => a.domain.localeCompare(b.domain))

    const groups: Group[] = []
    for (const st of STACKS) {
      const bucket = byStack.get(st)!
      groups.push({ id: st, label: st, level: 0, color: stackColor(st), sites: bucket })
      if (st === "Non-WP") {
        for (const sub of NONWP_SUBS) {
          const subSites = bucket.filter((site) => (probes.get(site.id)?.result.kind ?? null) === sub.kind)
          if (subSites.length === 0) continue
          groups.push({
            id: `nonwp:${sub.label}`,
            label: sub.label,
            level: 1,
            color: sub.kind ? probeKindColor(sub.kind) : theme.textFaint,
            sites: subSites,
          })
        }
      }
    }
    const php = [...phpCounts.entries()].sort((a, b) => phpSortKey(b[0]) - phpSortKey(a[0]))
    return { groups, php }
  }, [sites, probes])

  // Keep selection in range as groups appear/disappear with probing.
  const safeGroupIndex = Math.min(groupIndex, groups.length - 1)
  const selectedGroup = groups[safeGroupIndex]
  const groupSites = selectedGroup?.sites ?? []
  const total = sites.length || 1

  useEffect(() => {
    setSiteIndex(0)
  }, [safeGroupIndex])

  const isActive = route === "stacks" && !inputMode && !overlayOpen

  useKeyboard((key) => {
    if (!isActive) return

    // OpenTUI delivers letters lowercased with a `shift` flag (Shift+D → name
    // "d", shift true), so normalize to an uppercase letter when shift is held
    // before matching. This is what makes D distinct from d (and G from g).
    const name = key.name ?? ""
    const k = key.shift && name.length === 1 ? name.toUpperCase() : name

    const moveBy = (delta: number) => {
      if (focus === "groups") setGroupIndex((i) => moveSelection(i, delta, groups.length))
      else setSiteIndex((i) => moveSelection(i, delta, groupSites.length))
    }

    switch (k) {
      case "up":
      case "k":
        return moveBy(-1)
      case "down":
      case "j":
        return moveBy(1)
      case "g":
        return focus === "groups" ? setGroupIndex(0) : setSiteIndex(0)
      case "G":
        return focus === "groups" ? setGroupIndex(groups.length - 1) : setSiteIndex(groupSites.length - 1)
      case "right":
      case "l":
      case "return":
      case "tab":
        if (focus === "groups" && groupSites.length > 0) setFocus("sites")
        return
      case "left":
      case "escape":
        if (focus === "sites") setFocus("groups")
        return
      case "o":
        if (focus === "sites" && groupSites[siteIndex]) {
          const s = groupSites[siteIndex]
          openUrl((s.https?.enabled ? "https://" : "http://") + s.domain)
          flashMsg(`Opening ${s.domain}…`)
        }
        return
      case "w":
        // Open the selected site in the SpinupWP web app.
        if (focus === "sites" && groupSites[siteIndex]) {
          openUrl(siteWebUrl(groupSites[siteIndex].id, accountSlug))
          flashMsg(accountSlug ? "Opening in SpinupWP…" : "Set accountSlug for deep links — opening dashboard")
        }
        return
      case "d":
        // Single probe of the selected site (sites pane only).
        if (focus === "sites" && groupSites[siteIndex]) {
          const s = groupSites[siteIndex]
          runProbe(s)
          flashMsg(`Probing ${s.domain}…`)
        }
        return
      case "u":
        // Upgrade the selected site's PHP version (sites pane only).
        if (focus === "sites" && groupSites[siteIndex]) setPhpUpgradeSite(groupSites[siteIndex])
        return
      case "D":
        // Probe the ENTIRE selected group, in list order (top→down), regardless
        // of cursor or focus. runProbeMany skips any already in flight; target
        // only un-probed sites by selecting the "unprobed" sub-group first.
        if (selectedGroup && selectedGroup.sites.length > 0) {
          runProbeMany(selectedGroup.sites)
          flashMsg(`Probing ${selectedGroup.label} (${selectedGroup.sites.length})…`)
        }
        return
    }
  })

  const listRows = Math.max(3, rows - 6)
  const maxPhp = Math.max(1, ...php.map(([, n]) => n))

  const hints =
    focus === "groups"
      ? [
          { key: "↑↓/jk", label: "select" },
          { key: "→/⏎", label: "view sites" },
          { key: "D", label: "detect all" },
        ]
      : [
          { key: "↑↓/jk", label: "select site" },
          { key: "←/esc", label: "back" },
          { key: "d", label: "detect" },
          { key: "u", label: "upgrade PHP" },
          { key: "o", label: "open" },
          { key: "w", label: "SpinupWP" },
        ]

  // Status priority: transient flash > batch progress > selected site's error.
  const selectedSite = focus === "sites" ? groupSites[siteIndex] : undefined
  const selectedError = selectedSite ? probeErrors.get(selectedSite.id) : undefined
  const statusMessage = flash ?? (probingIds.size > 0 ? `⟳ probing ${probingIds.size}…` : selectedError ? `⚠ ${selectedError}` : undefined)
  const statusColorMsg = selectedError && !flash && probingIds.size === 0 ? theme.bad : theme.brand

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexGrow: 1, flexDirection: "row", padding: 1, gap: 1 }}>
        {/* Composition groups (top-level buckets + Non-WP sub-rows) */}
        <Panel title={` Stacks (${sites.length}) `} active={focus === "groups"} width={36}>
          <box style={{ flexGrow: 1, flexDirection: "column" }}>
            {groups.map((grp, i) => {
              const n = grp.sites.length
              const selected = i === safeGroupIndex
              const sel = selected && focus === "groups"
              const rowBg = selected ? (focus === "groups" ? theme.selectedBg : theme.bgAlt) : undefined
              if (grp.level === 1) {
                // Indented sub-row: label + count (no bar).
                return (
                  <box key={grp.id} style={{ flexDirection: "row", height: 1, backgroundColor: rowBg }}>
                    <text content="  └ " fg={theme.textFaint} style={{ flexShrink: 0 }} />
                    <text
                      content={grp.label}
                      fg={sel ? theme.text : grp.color}
                      wrapMode="none"
                      style={{ flexGrow: 1, flexShrink: 1 }}
                    />
                    <text content={String(n).padStart(4)} fg={sel ? theme.text : theme.textDim} style={{ flexShrink: 0 }} />
                  </box>
                )
              }
              const frac = n / total
              return (
                <box key={grp.id} style={{ flexDirection: "row", height: 1, backgroundColor: rowBg }}>
                  <text content={grp.label.padEnd(12)} fg={sel ? theme.text : grp.color} wrapMode="none" style={{ flexShrink: 0 }} />
                  <text content={bar(frac, 8)} fg={sel ? theme.text : grp.color} style={{ flexShrink: 0 }} />
                  <text content={String(n).padStart(4)} fg={sel ? theme.text : theme.text} style={{ flexShrink: 0 }} />
                  <text content={`${(frac * 100).toFixed(0)}%`.padStart(5)} fg={sel ? theme.text : theme.textFaint} style={{ flexShrink: 0 }} />
                </box>
              )
            })}
          </box>
        </Panel>

        {/* Sites in the selected group */}
        <Panel title={` ${selectedGroup?.label ?? "—"} · sites (${groupSites.length}) `} active={focus === "sites"} flexGrow={1}>
          <List
            items={groupSites}
            selectedIndex={siteIndex}
            viewportRows={listRows}
            focused={focus === "sites"}
            keyFor={(s) => s.id}
            emptyText="No sites in this group"
            renderRow={(s, selected) => {
              const cached = probes.get(s.id)
              const probing = probingIds.has(s.id)
              const errored = probeErrors.has(s.id)
              const faint = selected ? theme.text : theme.textFaint
              return (
                <>
                  <text content={statusDot(s.status) + " "} fg={statusColor(s.status)} style={{ flexShrink: 0 }} />
                  <text
                    content={truncate(s.domain, 40)}
                    fg={selected ? theme.text : theme.textDim}
                    wrapMode="none"
                    style={{ flexGrow: 1, flexShrink: 1 }}
                  />
                  <box style={{ flexShrink: 0, flexDirection: "row", marginLeft: 1 }}>
                    {probing ? (
                      <Spinner color={selected ? theme.text : theme.brand} />
                    ) : cached ? (
                      <text
                        content={truncate(cached.result.label, 20) + (isProbeStale(s) ? "*" : "")}
                        fg={probeKindColor(cached.result.kind, selected)}
                        wrapMode="none"
                      />
                    ) : errored ? (
                      <text content="probe failed" fg={selected ? theme.text : theme.bad} wrapMode="none" />
                    ) : (
                      <text content="· press d" fg={faint} wrapMode="none" />
                    )}
                  </box>
                  <text
                    content={truncate(serverById(s.server_id)?.name ?? "", 16)}
                    fg={faint}
                    wrapMode="none"
                    style={{ flexShrink: 0, marginLeft: 1 }}
                  />
                  <box style={{ flexShrink: 0, marginLeft: 1 }}>
                    <PhpVersionCell version={s.php_version} upgrade={phpUpgrades.get(s.id)} selected={selected} eol={isPhpEol(s.php_version)} />
                  </box>
                </>
              )
            }}
          />
        </Panel>

        {/* PHP version distribution (fleet-wide) */}
        <Panel title=" PHP versions " width={30}>
          <box style={{ flexGrow: 1, flexDirection: "column" }}>
            {php.map(([v, n]) => {
              const eol = isPhpEol(v)
              return (
                <box key={v} style={{ flexDirection: "row", height: 1 }}>
                  <text content={v.padEnd(6)} fg={eol ? theme.bad : theme.text} style={{ flexShrink: 0 }} />
                  <text content={bar(n / maxPhp, 8)} fg={eol ? theme.bad : theme.brandDim} style={{ flexShrink: 0 }} />
                  <text content={String(n).padStart(4)} fg={theme.textDim} style={{ flexShrink: 0 }} />
                  <text content={eol ? " EOL" : ""} fg={theme.bad} style={{ flexShrink: 0 }} />
                </box>
              )
            })}
          </box>
        </Panel>
      </box>
      <StatusBar hints={hints} message={statusMessage} messageColor={statusColorMsg} />
    </box>
  )
}

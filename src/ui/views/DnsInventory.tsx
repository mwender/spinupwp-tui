// DNS inventory for a server — a MIGRATION lens, not a zone editor. For every site
// on the server it shows the website-hosting records that "count" when you move
// the site to another server: each zone, and nested under it the site's own
// hostnames (apex, www, additional domains) with their live record + TTL, flagged
// when they point at THIS server. The full per-zone record list lives in the `⏎`
// drill-down (DnsRecords) — that's where editing happens. Opened with `N`.
//
// TTLs here are read CRED-FREE from each zone's authoritative nameserver (the
// configured, non-decremented value), so they show for every host — not just the
// ones we hold an API key for. Editing a TTL still needs a connected account.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme, statusColor, statusDot } from "../../lib/theme.ts"
import { truncate, timeAgo } from "../../lib/format.ts"
import { normalizeDomain, candidateHostnames } from "../../lib/dns.ts"
import { formatTtl } from "../../lib/dnsRecords.ts"
import { apiProviderFor, consoleForHost, type AccessState } from "../../lib/providers.ts"
import { openUrl, copyToClipboard } from "../../lib/open.ts"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { Spinner } from "../components.tsx"
import { useStore } from "../store.tsx"
import type { Site } from "../../api/types.ts"

// Fixed column widths (chars) so columns align on every row; VALUE flexes.
const SITE_W = 22
const NAME_W = 30
const TYPE_W = 7
const TTL_W = 8
const HOST_W = 16
const ACCESS_W = 8
const ACCOUNT_W = 16

// Glyph + color for an access state. `·` is the resting/unknown state.
function accessGlyph(state: AccessState, selected: boolean): { glyph: string; color: string } {
  switch (state) {
    case "editable":
      return { glyph: "✓", color: selected ? theme.text : theme.good }
    case "web":
      return { glyph: "↗", color: selected ? theme.text : theme.accent }
    case "needs-key":
      return { glyph: "○", color: selected ? theme.text : theme.warn }
    default:
      return { glyph: "·", color: selected ? theme.text : theme.textFaint }
  }
}

// A zone-header row, or a hosting-record row nested under it. Both carry the zone
// identity (apex/hostKey/access/liveNs) so access/edit actions work from either.
type InvRow =
  | {
      kind: "zone"
      siteDomain: string
      showSite: boolean
      status: string
      apex: string
      hostKey: string
      host: string
      hostColor: string
      access: AccessState
      account: string
      liveNs: string[]
      note: string
      checkedAt: number | null
    }
  | {
      kind: "record"
      apex: string
      hostKey: string
      access: AccessState
      liveNs: string[]
      name: string // the hostname
      recordType: string // A | CNAME | AAAA | "" while resolving
      ttl: number | null
      value: string
      pointsHere: boolean
      resolving: boolean
    }

export function DnsInventory() {
  const {
    dnsInventoryServer,
    setDnsInventoryServer,
    sitesForServer,
    zoneForDomain,
    lookupServerDns,
    dnsZones,
    dnsResolving,
    accessForZone,
    accountForZone,
    connForZone,
    setConnectZoneTarget,
    connectZoneTarget,
    dnsRecordsTarget,
    setDnsRecordsTarget,
    connectionCount,
    providerZones,
    connections,
    verifyConnectionById,
    resolveServerHosting,
    hostingFor,
    isHostingResolving,
  } = useStore()
  const allConnections = useMemo(() => Object.values(connections).flat(), [connections])
  const showAccount = connectionCount >= 2
  const { height } = useTerminalDimensions()
  const [index, setIndex] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const server = dnsInventoryServer

  // Kick off zone-host resolution when the overlay opens.
  useEffect(() => {
    if (server) lookupServerDns(server.id)
  }, [server, lookupServerDns])

  // Resolve hosting records once their zone NS are known — re-runs as zones land
  // (already-resolved/in-flight hostnames are skipped, so this is cheap).
  useEffect(() => {
    if (server) resolveServerHosting(server)
  }, [server, dnsZones, resolveServerHosting])

  // Verify configured-but-unverified connections so `✓` access appears without a
  // manual re-verify.
  useEffect(() => {
    for (const c of allConnections) if (!providerZones.has(c.id)) verifyConnectionById(c.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allConnections, verifyConnectionById])

  const sites = useMemo<Site[]>(
    () => (server ? [...sitesForServer(server.id)].sort((a, b) => a.domain.localeCompare(b.domain)) : []),
    [server, sitesForServer],
  )

  const { rows, summary, pending } = useMemo(() => {
    const out: InvRow[] = []
    let zoneCount = 0
    let hereCount = 0
    let resolving = false

    for (const site of sites) {
      const entries = [
        { domain: site.domain, redirect: undefined as { enabled: boolean; destination: string } | undefined },
        ...(site.additional_domains?.map((a) => ({ domain: a.domain, redirect: a.redirect })) ?? []),
      ]
      const primaryApex = zoneForDomain(site.domain)?.zone?.apex ?? normalizeDomain(site.domain)

      const groups = new Map<string, { apex: string; entries: typeof entries }>()
      for (const e of entries) {
        const apex = zoneForDomain(e.domain)?.zone?.apex ?? normalizeDomain(e.domain)
        const g = groups.get(apex) ?? { apex, entries: [] }
        g.entries.push(e)
        groups.set(apex, g)
      }
      const ordered = [...groups.values()].sort((a, b) =>
        a.apex === primaryApex ? -1 : b.apex === primaryApex ? 1 : a.apex.localeCompare(b.apex),
      )

      ordered.forEach((g, idx) => {
        zoneCount++
        const cached = zoneForDomain(g.entries[0].domain)
        const zoneResolving = g.entries.some((e) => dnsResolving.has(normalizeDomain(e.domain)))
        const hostKey = cached?.zone?.providerKey ?? ""
        const liveNs = cached?.zone?.nameservers ?? []
        let host: string
        let hostColor: string
        if (cached === undefined) {
          host = zoneResolving ? "looking up…" : "—"
          hostColor = zoneResolving ? theme.textDim : theme.textFaint
          resolving = resolving || zoneResolving
        } else if (cached.zone === null) {
          host = "no host found"
          hostColor = theme.warn
        } else {
          host = cached.zone.providerLabel
          hostColor = theme.accent
        }
        const isPrimaryZone = g.apex === primaryApex
        const redirect = g.entries.find((e) => e.redirect?.enabled)?.redirect
        const note = !isPrimaryZone && redirect ? `→ redirects to ${redirect.destination}` : ""
        const access = accessForZone(g.apex, hostKey, liveNs)

        out.push({
          kind: "zone",
          siteDomain: site.domain,
          showSite: idx === 0,
          status: site.status,
          apex: g.apex,
          hostKey,
          host,
          hostColor,
          access,
          account: accountForZone(g.apex, hostKey, liveNs),
          liveNs,
          note,
          checkedAt: cached?.checkedAt ?? null,
        })

        // Nested hosting records: the site's hostnames in this zone (apex first).
        const hosts = candidateHostnames(g.entries.map((e) => e.domain)).sort((a, b) =>
          a === g.apex ? -1 : b === g.apex ? 1 : a.localeCompare(b),
        )
        for (const name of hosts) {
          const hr = hostingFor(name)
          if (hr && hr.type === "none") continue // no record for this hostname — nothing to migrate
          const isResolving = isHostingResolving(name) || (!hr && cached?.zone != null)
          if (hr?.pointsHere) hereCount++
          if (!hr && isResolving) resolving = true
          out.push({
            kind: "record",
            apex: g.apex,
            hostKey,
            access,
            liveNs,
            name,
            recordType: hr?.type ?? "",
            ttl: hr?.ttl ?? null,
            value: hr?.value ?? "",
            pointsHere: hr?.pointsHere ?? false,
            resolving: !hr,
          })
        }
      })
    }

    const summary = `${zoneCount} zone${zoneCount === 1 ? "" : "s"}${hereCount ? ` · ${hereCount} point${hereCount === 1 ? "s" : ""} here` : ""}`
    return { rows: out, summary, pending: resolving }
  }, [sites, dnsZones, dnsResolving, zoneForDomain, accessForZone, accountForZone, hostingFor, isHostingResolving])

  const safeIndex = Math.min(index, Math.max(0, rows.length - 1))
  const close = () => setDnsInventoryServer(null)

  function openDrill(r: InvRow) {
    if (r.access === "web") return openWeb(r)
    if (r.access !== "editable") return showFlash("Connect API access first — press c")
    const conn = connForZone(r.apex, r.hostKey, r.liveNs)
    if (!conn) return showFlash("No reachable account for this zone — press c")
    const focus = r.kind === "record" && r.recordType ? { name: r.name, type: r.recordType } : undefined
    setDnsRecordsTarget({ apex: r.apex, hostKey: r.hostKey, connId: conn.id, focus })
  }

  function openWeb(r: InvRow) {
    const con = consoleForHost(r.hostKey)
    if (con) {
      copyToClipboard(r.apex)
      openUrl(con.url)
      showFlash(`${con.label} opened · ${r.apex} copied`)
    } else {
      showFlash("No web console for this host — c to manage access")
    }
  }

  function showFlash(msg: string) {
    if (!msg) return
    setFlash(msg)
    setTimeout(() => setFlash(null), 2200)
  }

  useKeyboard((key) => {
    if (connectZoneTarget || dnsRecordsTarget) return // an overlay on top owns the keyboard
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw
    const r = rows[safeIndex]
    switch (name) {
      case "escape":
      case "q":
        return close()
      case "up":
      case "k":
        return setIndex((i) => moveSelection(i, -1, rows.length))
      case "down":
      case "j":
        return setIndex((i) => moveSelection(i, 1, rows.length))
      case "r":
        if (server) {
          lookupServerDns(server.id, true)
          resolveServerHosting(server, true)
        }
        return
      case "return":
      case "right":
      case "l":
      case "t":
        if (r) openDrill(r)
        return
      case "c":
        if (!r) return
        if (apiProviderFor(r.hostKey)) setConnectZoneTarget({ apex: r.apex, hostKey: r.hostKey })
        else openWeb(r)
        return
      case "w":
        if (r) openWeb(r)
        return
    }
  })

  if (!server) return null
  const listRows = Math.max(3, height - 7)
  const oldest = rows.reduce<number | null>(
    (min, r) => (r.kind === "zone" && r.checkedAt && (min === null || r.checkedAt < min) ? r.checkedAt : min),
    null,
  )

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 216 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content={`🌐 DNS · ${truncate(server.name, 26)}  `} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={summary} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        {pending ? <Spinner color={theme.brand} interval={120} /> : null}
      </box>

      {/* Column header. SITE/zone-or-record name align across both row kinds. */}
      <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text content={"  " + "SITE".padEnd(SITE_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"ZONE / RECORD".padEnd(NAME_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"TYPE".padEnd(TYPE_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"TTL".padEnd(TTL_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="VALUE / HOST" fg={theme.textFaint} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
      </box>

      {/* Legend — teaches access glyphs + the "points here" flag in-context. */}
      <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text content="✓ editable" fg={theme.good} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="   ↗ web" fg={theme.accent} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="   ○ needs key" fg={theme.warn} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="   ◀ here = points at this server" fg={theme.good} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="    ⏎ edit TTL · c access" fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
        {rows.length === 0 ? (
          <text content="No sites on this server." fg={theme.textFaint} wrapMode="none" />
        ) : (
          <List
            items={rows}
            selectedIndex={safeIndex}
            viewportRows={listRows}
            focused
            keyFor={(_r, i) => i}
            renderRow={(r, selected) => (r.kind === "zone" ? renderZone(r, selected) : renderRecord(r, selected))}
          />
        )}
      </box>

      <StatusBar
        hints={[
          { key: "↑↓/jk", label: "select" },
          { key: "⏎", label: "edit TTL" },
          { key: "c", label: "manage access" },
          { key: "w", label: "web console" },
          { key: "r", label: "refresh" },
          { key: "esc", label: "close" },
        ]}
        message={flash ?? (oldest ? `checked ${timeAgo(new Date(oldest).toISOString())}` : undefined)}
        messageColor={flash ? theme.brand : theme.textFaint}
        showGlobal={false}
      />
    </box>
  )

  function renderZone(r: Extract<InvRow, { kind: "zone" }>, selected: boolean) {
    const acc = accessGlyph(r.access, selected)
    return (
      <>
        <text content={r.showSite ? statusDot(r.status) + " " : "  "} fg={statusColor(r.status)} style={{ flexShrink: 0 }} />
        <text content={(r.showSite ? truncate(r.siteDomain, SITE_W - 1) : "").padEnd(SITE_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={truncate(r.apex, NAME_W - 1).padEnd(NAME_W)} fg={selected ? theme.text : theme.text} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={truncate(r.host, HOST_W - 1).padEnd(HOST_W)} fg={selected ? theme.text : r.hostColor} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={(acc.glyph + " ").padEnd(ACCESS_W)} fg={acc.color} wrapMode="none" style={{ flexShrink: 0 }} />
        {showAccount ? <text content={truncate(r.account, ACCOUNT_W - 1).padEnd(ACCOUNT_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
        <text content={r.note} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
      </>
    )
  }

  function renderRecord(r: Extract<InvRow, { kind: "record" }>, selected: boolean) {
    const ttlFg = selected ? theme.text : theme.accent
    return (
      <>
        <text content="  " style={{ flexShrink: 0 }} />
        <text content={"".padEnd(SITE_W)} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={("  ↳ " + truncate(r.name, NAME_W - 5)).padEnd(NAME_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
        {r.resolving ? (
          <box style={{ flexDirection: "row", width: TYPE_W + TTL_W, flexShrink: 0 }}>
            <Spinner color={selected ? theme.text : theme.textDim} interval={120} />
            <text content=" looking up…" fg={selected ? theme.text : theme.textFaint} wrapMode="none" />
          </box>
        ) : (
          <>
            <text content={r.recordType.padEnd(TYPE_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
            <text content={formatTtl(r.ttl).padEnd(TTL_W)} fg={ttlFg} wrapMode="none" style={{ flexShrink: 0 }} />
          </>
        )}
        <text content={truncate(r.value, 48)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
        {r.pointsHere ? <text content=" ◀ here" fg={selected ? theme.text : theme.good} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
      </>
    )
  }
}

// DNS zone-host inventory for a server — the read-only first slice of the DNS
// module. Answers "where is every domain on this server's DNS hosted?", the
// inventory you build by hand when migrating or cloning a site.
//
// The unit is the ZONE, not the hostname: www + apex collapse into one row, and a
// separate-TLD additional domain (e.g. example.net redirecting to example.com)
// surfaces as its OWN zone with its OWN host — because a full move must carry the
// whole portfolio, and those can live on a different provider. Opened with `N`.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme, statusColor, statusDot } from "../../lib/theme.ts"
import { truncate, timeAgo } from "../../lib/format.ts"
import { normalizeDomain } from "../../lib/dns.ts"
import { apiProviderFor, consoleForHost, type AccessState } from "../../lib/providers.ts"
import { openUrl, copyToClipboard } from "../../lib/open.ts"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { Spinner } from "../components.tsx"
import { useStore } from "../store.tsx"
import type { Site } from "../../api/types.ts"

// Fixed column widths (chars) so SITE/ZONE/HOST/ACCESS align on every row; NOTE
// flexes to fill the remainder. Each cell truncates to width-1 for a 1-space gutter.
const SITE_W = 38
const ZONE_W = 44
const HOST_W = 18
const ACCESS_W = 8
const ACCOUNT_W = 18

// Glyph + color for an access state (Phase 2). `·` is the resting/unknown state.
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

interface ZoneRow {
  siteDomain: string // owning site (primary domain)
  showSite: boolean // first zone row for this site (others blank the column)
  status: string // owning site status (for the leading dot)
  zone: string // zone apex (or normalized domain when unresolved)
  hostKey: string // provider key from DNS detection (drives access + the `c` action)
  host: string // provider label, or a lookup-state string
  hostColor: string
  access: AccessState // editable | needs-key | web | unknown
  account: string // owning connection/account label (editable zones only)
  note: string // e.g. "→ redirects to example.com"
  checkedAt: number | null // age of the cached lookup, null when not yet known
}

export function DnsInventory() {
  const { dnsInventoryServer, setDnsInventoryServer, sitesForServer, zoneForDomain, lookupServerDns, dnsZones, dnsResolving, accessForZone, accountForZone, setConnectZoneTarget, connectZoneTarget, connections, connectionCount, providerZones, verifyConnectionById } =
    useStore()
  const allConnections = useMemo(() => Object.values(connections).flat(), [connections])
  // Show the ACCOUNT column only when more than one account is connected (else
  // it's the same label on every editable row — just noise).
  const showAccount = connectionCount >= 2
  const { height } = useTerminalDimensions()
  const [index, setIndex] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const server = dnsInventoryServer

  // Kick off resolution for any un-cached domains when the overlay opens.
  useEffect(() => {
    if (server) lookupServerDns(server.id)
  }, [server, lookupServerDns])

  // Verify any configured-but-not-yet-verified connections so `✓` access appears
  // without a manual re-verify (e.g. connections from a prior session or env).
  // Cached ones are left alone; re-verify is on demand (connect overlay `v`).
  useEffect(() => {
    for (const c of allConnections) {
      if (!providerZones.has(c.id)) verifyConnectionById(c.id)
    }
    // providerZones intentionally omitted: verify once per connection, not on each
    // cache update (which would re-fire mid-flight).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allConnections, verifyConnectionById])

  const sites = useMemo<Site[]>(
    () => (server ? [...sitesForServer(server.id)].sort((a, b) => a.domain.localeCompare(b.domain)) : []),
    [server, sitesForServer],
  )

  // Build the zone-keyed rows. Recomputes as lookups land (dnsZones changes).
  const { rows, summary, resolvedZones, totalZones } = useMemo(() => {
    const out: ZoneRow[] = []
    const tally = new Map<string, number>() // host label → zone count
    let total = 0
    let resolved = 0

    for (const site of sites) {
      const entries = [
        { domain: site.domain, redirect: undefined as { enabled: boolean; destination: string } | undefined },
        ...(site.additional_domains?.map((a) => ({ domain: a.domain, redirect: a.redirect })) ?? []),
      ]
      const primaryApex = zoneForDomain(site.domain)?.zone?.apex ?? normalizeDomain(site.domain)

      // Group the site's domains by zone apex.
      const groups = new Map<string, { apex: string; entries: typeof entries }>()
      for (const e of entries) {
        const apex = zoneForDomain(e.domain)?.zone?.apex ?? normalizeDomain(e.domain)
        const g = groups.get(apex) ?? { apex, entries: [] }
        g.entries.push(e)
        groups.set(apex, g)
      }

      // Primary zone first, then alphabetical.
      const ordered = [...groups.values()].sort((a, b) =>
        a.apex === primaryApex ? -1 : b.apex === primaryApex ? 1 : a.apex.localeCompare(b.apex),
      )

      ordered.forEach((g, idx) => {
        total++
        const cached = zoneForDomain(g.entries[0].domain)
        const resolving = g.entries.some((e) => dnsResolving.has(normalizeDomain(e.domain)))
        let host: string
        let hostColor: string
        const hostKey = cached?.zone?.providerKey ?? ""
        const liveNs = cached?.zone?.nameservers ?? []
        if (cached === undefined) {
          host = resolving ? "looking up…" : "—"
          hostColor = resolving ? theme.textDim : theme.textFaint
        } else if (cached.zone === null) {
          host = "no host found"
          hostColor = theme.warn
          resolved++
        } else {
          host = cached.zone.providerLabel
          hostColor = theme.accent
          resolved++
          tally.set(host, (tally.get(host) ?? 0) + 1)
        }
        // A note only when this zone is NOT the canonical one and redirects away.
        const isPrimaryZone = g.apex === primaryApex
        const redirect = g.entries.find((e) => e.redirect?.enabled)?.redirect
        const note = !isPrimaryZone && redirect ? `→ redirects to ${redirect.destination}` : ""
        out.push({
          siteDomain: site.domain,
          showSite: idx === 0,
          status: site.status,
          zone: g.apex,
          hostKey,
          host,
          hostColor,
          access: accessForZone(g.apex, hostKey, liveNs),
          account: accountForZone(g.apex, hostKey, liveNs),
          note,
          checkedAt: cached?.checkedAt ?? null,
        })
      })
    }

    const parts = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => `${n} ${label}`)
    const pending = total - resolved
    if (pending > 0) parts.push(`${pending} resolving`)
    const summary = `${total} zone${total === 1 ? "" : "s"}${parts.length ? " · " + parts.join(" · ") : ""}`
    return { rows: out, summary, resolvedZones: resolved, totalZones: total }
  }, [sites, dnsZones, dnsResolving, zoneForDomain, accessForZone, accountForZone])

  const safeIndex = Math.min(index, Math.max(0, rows.length - 1))
  const close = () => setDnsInventoryServer(null)

  useKeyboard((key) => {
    if (connectZoneTarget) return // the connect overlay (on top) owns the keyboard
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw
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
        if (server) lookupServerDns(server.id, true)
        return
      case "c": {
        // Manage access for the selected zone: connect an API provider, or open
        // the web console for a host we can't drive via API.
        const r = rows[safeIndex]
        if (!r) return
        if (apiProviderFor(r.hostKey)) setConnectZoneTarget({ apex: r.zone, hostKey: r.hostKey })
        else openWeb(r)
        return
      }
      case "w": {
        // Quick web handoff for the selected zone (e.g. GoDaddy Clients hub),
        // copying the domain so it's ready to paste — no overlay round-trip.
        const r = rows[safeIndex]
        if (r) openWeb(r)
        return
      }
    }
  })

  function openWeb(r: ZoneRow) {
    const con = consoleForHost(r.hostKey)
    if (con) {
      copyToClipboard(r.zone)
      openUrl(con.url)
      showFlash(`${con.label} opened · ${r.zone} copied`)
    } else {
      showFlash("No web console for this host — c to manage access")
    }
  }

  function showFlash(msg: string) {
    if (!msg) return
    setFlash(msg)
    setTimeout(() => setFlash(null), 2000)
  }

  if (!server) return null
  const listRows = Math.max(3, height - 7)
  const oldest = rows.reduce<number | null>((min, r) => (r.checkedAt && (min === null || r.checkedAt < min) ? r.checkedAt : min), null)

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 216 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content={`🌐 DNS hosts · ${truncate(server.name, 28)}  `} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={summary} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        {resolvedZones < totalZones ? <Spinner color={theme.brand} interval={120} /> : null}
      </box>

      {/* Column header — fixed widths so SITE/ZONE/HOST/ACCESS line up on every row;
          the leading "  " matches the status-dot cell. NOTE (last) flexes to fill. */}
      <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text content={"  " + "SITE".padEnd(SITE_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"ZONE".padEnd(ZONE_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"HOST".padEnd(HOST_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"ACCESS".padEnd(ACCESS_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        {showAccount ? <text content={"ACCOUNT".padEnd(ACCOUNT_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
        <text content="NOTE" fg={theme.textFaint} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
      </box>

      {/* Access legend — teaches the glyphs + the c action in-context. */}
      <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text content="ACCESS  " fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="✓ editable" fg={theme.good} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="   ↗ web only" fg={theme.accent} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="   ○ needs key" fg={theme.warn} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="   · unknown" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="    c manage access" fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
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
            emptyText="—"
            renderRow={(r, selected) => {
              const acc = accessGlyph(r.access, selected)
              return (
                <>
                  <text content={r.showSite ? statusDot(r.status) + " " : "  "} fg={statusColor(r.status)} style={{ flexShrink: 0 }} />
                  <text content={(r.showSite ? truncate(r.siteDomain, SITE_W - 1) : "").padEnd(SITE_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
                  <text content={truncate(r.zone, ZONE_W - 1).padEnd(ZONE_W)} fg={theme.text} wrapMode="none" style={{ flexShrink: 0 }} />
                  <text content={truncate(r.host, HOST_W - 1).padEnd(HOST_W)} fg={selected ? theme.text : r.hostColor} wrapMode="none" style={{ flexShrink: 0 }} />
                  <text content={(acc.glyph + " ").padEnd(ACCESS_W)} fg={acc.color} wrapMode="none" style={{ flexShrink: 0 }} />
                  {showAccount ? <text content={truncate(r.account, ACCOUNT_W - 1).padEnd(ACCOUNT_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
                  <text content={r.note} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                </>
              )
            }}
          />
        )}
      </box>

      <StatusBar
        hints={[
          { key: "↑↓/jk", label: "scroll" },
          { key: "c", label: "manage access" },
          { key: "w", label: "web console" },
          { key: "r", label: "refresh lookups" },
          { key: "esc", label: "close" },
        ]}
        message={flash ?? (oldest ? `checked ${timeAgo(new Date(oldest).toISOString())}` : undefined)}
        messageColor={flash ? theme.brand : theme.textFaint}
        showGlobal={false}
      />
    </box>
  )
}

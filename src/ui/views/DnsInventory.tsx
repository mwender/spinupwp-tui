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
import { apiProviderFor, consoleForHost, type AccessState } from "../../lib/providers.ts"
import { openUrl, copyToClipboard } from "../../lib/open.ts"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { Spinner } from "../components.tsx"
import { useStore, isTtlWriteInFlight } from "../store.tsx"
import type { Site } from "../../api/types.ts"

// Fixed column widths (chars) so columns align on every row; VALUE flexes.
// Fixed column widths (chars). VALUE flexes; HOST/ACCOUNT sit on the right.
const NAME_W = 32
const TYPE_W = 6
const TTL_W = 8
const HOST_W = 14
const ACCOUNT_W = 16

// Lowercase a hostname and drop a trailing dot (for comparisons).
const norm = (d: string) => d.trim().toLowerCase().replace(/\.$/, "")

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

// A folded zone line (zone identity + its apex hosting record, when the site is
// served at the apex), or a hosting-record row nested under it for the non-apex
// records that still need action (own-A www, subdomains). Both carry the zone
// identity (apex/hostKey/access/liveNs) so access/edit actions work from either.
type InvRow =
  | {
      kind: "zone"
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
      // Site grouping: the primary zone is the site's `●` line; additional-domain
      // zones nest under it as `↳` lines. `extraZones` (on the primary) drives the
      // "(+N)" portfolio hint.
      isPrimary: boolean
      extraZones: number
      // The site's own hosting record, folded into this line. `recordName` is the
      // hostname it belongs to (the site's domain — apex for a root site, the
      // subdomain for a subdomain-hosted site), used as the label + the edit target.
      recordName: string
      hasRecord: boolean
      recordType: string // A | AAAA | CNAME | ""
      ttl: number | null
      value: string
      pointsHere: boolean
      resolving: boolean // apex record still being looked up
      wwwFollows: boolean // a www CNAME that just follows the apex → shown as "+www"
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
      followsApex: boolean // a www/alias CNAME pointing at the apex — follows it on a move, no edit needed
      resolving: boolean
      indent: number // 1 = record under the primary zone; 2 = under an additional-domain zone
    }

export function DnsInventory() {
  const {
    dnsInventoryServer,
    dnsInventoryFocusSiteId,
    setDnsInventoryServer,
    setDnsInventoryFocusSiteId,
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
    ttlWriteForHost,
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

  const allSites = useMemo<Site[]>(
    () => (server ? [...sitesForServer(server.id)].sort((a, b) => a.domain.localeCompare(b.domain)) : []),
    [server, sitesForServer],
  )
  // When opened via `n`, scope the rows to a single site; `N` shows them all.
  const focusSite = dnsInventoryFocusSiteId != null ? allSites.find((s) => s.id === dnsInventoryFocusSiteId) ?? null : null
  const sites = useMemo<Site[]>(() => (focusSite ? [focusSite] : allSites), [focusSite, allSites])

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
      const additionalZones = ordered.length - 1

      ordered.forEach((g) => {
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

        // The site's hostnames in this zone (apex first).
        const hosts = candidateHostnames(g.entries.map((e) => e.domain)).sort((a, b) =>
          a === g.apex ? -1 : b === g.apex ? 1 : a.localeCompare(b),
        )
        // The line's head = the SITE's own domain in this zone: the apex when the site
        // is served at the root, otherwise the subdomain the site actually lives at
        // (so three sites on one apex read as three distinct lines, not one).
        const headHost = hosts.includes(g.apex) ? g.apex : norm(g.entries[0].domain)
        const headRec = hostingFor(headHost)
        const headResolving = isHostingResolving(headHost) || (!headRec && cached?.zone != null)
        const hasRecord = !!(headRec && headRec.type !== "none")
        // A www that merely CNAMEs to the head (or apex) follows it on a move → "+www".
        const wwwName = "www." + headHost
        const wwwRec = headHost.startsWith("www.") ? undefined : hostingFor(wwwName)
        const wwwTarget = wwwRec?.type === "CNAME" ? norm(wwwRec.value) : ""
        const wwwFollows = wwwTarget !== "" && (wwwTarget === headHost || wwwTarget === g.apex)
        if (hasRecord && headRec!.pointsHere) hereCount++
        if (headResolving) resolving = true

        out.push({
          kind: "zone",
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
          isPrimary: isPrimaryZone,
          extraZones: isPrimaryZone ? additionalZones : 0,
          recordName: headHost,
          hasRecord,
          recordType: headRec?.type ?? "",
          ttl: headRec?.ttl ?? null,
          value: headRec?.value ?? "",
          pointsHere: headRec?.pointsHere ?? false,
          resolving: headResolving,
          wwwFollows,
        })

        // Nested rows: only the non-head records that still need action.
        for (const name of hosts) {
          if (name === headHost) continue // folded into the site/zone line
          if (name === wwwName && wwwFollows) continue // shown as "+www"
          const hr = hostingFor(name)
          if (hr && hr.type === "none") continue // no record for this hostname — nothing to migrate
          const isResolving = isHostingResolving(name) || (!hr && cached?.zone != null)
          if (hr?.pointsHere) hereCount++
          if (!hr && isResolving) resolving = true
          const cnameTarget = hr?.type === "CNAME" ? hr.value.toLowerCase().replace(/\.$/, "") : ""
          const followsApex = cnameTarget !== "" && cnameTarget === g.apex
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
            followsApex,
            resolving: !hr,
            indent: isPrimaryZone ? 1 : 2,
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
    // Editing always targets ONE hosting record — never a zone. A record row edits
    // itself; a zone-header row edits its apex A/AAAA (the record right below it).
    let rec: { name: string; type: string } | null = null
    if (r.kind === "record") {
      if (r.followsApex) return showFlash(`${r.name} follows the apex — no separate change needed.`)
      if (r.resolving) return showFlash("Still looking up this record…")
      if (!r.recordType || r.recordType === "none") return showFlash("No record to edit here.")
      rec = { name: r.name, type: r.recordType }
    } else {
      if (r.resolving) return showFlash("Still looking up this record…")
      if (!r.hasRecord || !r.recordType) return showFlash("No record to edit on this line.")
      rec = { name: r.recordName, type: r.recordType }
    }
    setDnsRecordsTarget({ apex: r.apex, hostKey: r.hostKey, connId: conn.id, record: rec })
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
      case "a":
        // Expand a site-scoped view (opened via `n`) to the whole server.
        if (focusSite) {
          setDnsInventoryFocusSiteId(null)
          setIndex(0)
        }
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
        <text content={`🌐 DNS · ${truncate(focusSite ? focusSite.domain : server.name, 28)}  `} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={focusSite ? `${summary} · a all sites` : summary} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        {pending ? <Spinner color={theme.brand} interval={120} /> : null}
      </box>

      {/* Column header. The dot column (2) + NAME align across both row kinds; HOST
          sits on the right, pushed there by the growable VALUE region. */}
      <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text content={"  " + "SITE / RECORD".padEnd(NAME_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"TYPE".padEnd(TYPE_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"TTL".padEnd(TTL_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="VALUE" fg={theme.textFaint} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
        <text content="HOST" fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        {showAccount ? <text content={"  " + "ACCOUNT".padEnd(ACCOUNT_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
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
          ...(focusSite ? [{ key: "a", label: "all sites" }] : []),
          { key: "r", label: "refresh" },
          { key: "esc", label: "close" },
        ]}
        message={flash ?? (oldest ? `checked ${timeAgo(new Date(oldest).toISOString())}` : undefined)}
        messageColor={flash ? theme.brand : theme.textFaint}
        showGlobal={false}
      />
    </box>
  )

  // The TTL cell, shared by both row kinds: a spinner while resolving, a spinner +
  // "→<ttl>" while a write is in flight, else the value in seconds (300/3600/86400,
  // not "1h"). A settled write shows its new value — the authoritative host has it.
  function ttlCell(name: string, type: string, ttl: number | null, resolving: boolean, faint: boolean, selected: boolean) {
    if (resolving) {
      return (
        <box style={{ flexDirection: "row", width: TTL_W, flexShrink: 0 }}>
          <Spinner color={selected ? theme.text : theme.textDim} interval={120} />
          <text content=" …" fg={selected ? theme.text : theme.textFaint} wrapMode="none" />
        </box>
      )
    }
    const wp = ttlWriteForHost(name, type)
    if (isTtlWriteInFlight(wp)) {
      return (
        <box style={{ flexDirection: "row", width: TTL_W, flexShrink: 0 }}>
          <Spinner color={selected ? theme.text : theme.brand} interval={120} />
          <text content={` →${wp!.ttl}`} fg={selected ? theme.text : theme.warn} wrapMode="none" />
        </box>
      )
    }
    const effTtl = wp?.status === "done" ? wp.ttl : ttl
    const txt = effTtl == null ? "—" : String(effTtl)
    const fg = selected ? theme.text : faint ? theme.textFaint : theme.accent
    return <text content={txt.padEnd(TTL_W)} fg={fg} wrapMode="none" style={{ flexShrink: 0 }} />
  }

  // host + access glyph — a right-side cluster on zone lines.
  function hostCell(r: Extract<InvRow, { kind: "zone" }>, selected: boolean) {
    const acc = accessGlyph(r.access, selected)
    return (
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        <text content={truncate(r.host, HOST_W)} fg={selected ? theme.text : r.hostColor} wrapMode="none" />
        <text content={" " + acc.glyph} fg={acc.color} wrapMode="none" />
      </box>
    )
  }

  // Indented "↳ name" cell for nested rows. Level 1 = directly under the site's
  // primary line (additional-domain zone, or a record in the primary zone); level 2
  // = a record under an additional-domain zone.
  function indentedName(name: string, level: number): string {
    const prefix = level >= 2 ? "     ↳ " : "  ↳ "
    return (prefix + truncate(name, NAME_W - prefix.length - 1)).padEnd(NAME_W)
  }

  function renderZone(r: Extract<InvRow, { kind: "zone" }>, selected: boolean) {
    // Primary zone = the site's `●` line; additional-domain zones nest as `↳`. The
    // label is the site's own domain (recordName), not the zone apex.
    const nameContent = r.isPrimary ? truncate(r.recordName, NAME_W - 1).padEnd(NAME_W) : indentedName(r.recordName, 1)
    const nameColor = selected ? theme.text : r.isPrimary ? theme.text : theme.textDim
    return (
      <>
        <text content={r.isPrimary ? statusDot(r.status) + " " : "  "} fg={r.isPrimary ? statusColor(r.status) : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={nameContent} fg={nameColor} wrapMode="none" style={{ flexShrink: 0 }} />
        {r.hasRecord || r.resolving ? (
          <>
            <text content={r.recordType.padEnd(TYPE_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
            {ttlCell(r.recordName, r.recordType, r.ttl, r.resolving, false, selected)}
          </>
        ) : (
          <>
            <text content={"".padEnd(TYPE_W)} wrapMode="none" style={{ flexShrink: 0 }} />
            <text content={"".padEnd(TTL_W)} wrapMode="none" style={{ flexShrink: 0 }} />
          </>
        )}
        <text content={truncate(r.value, 38)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
        {r.pointsHere ? <text content=" ◀ here" fg={selected ? theme.text : theme.good} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
        {r.wwwFollows ? <text content=" +www" fg={selected ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
        {r.note ? <text content={"  " + r.note} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
        <box style={{ flexGrow: 1 }} />
        {hostCell(r, selected)}
        {r.isPrimary && r.extraZones > 0 ? <text content={`  (+${r.extraZones})`} fg={selected ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
        {showAccount ? <text content={"  " + truncate(r.account, ACCOUNT_W).padEnd(ACCOUNT_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
      </>
    )
  }

  function renderRecord(r: Extract<InvRow, { kind: "record" }>, selected: boolean) {
    return (
      <>
        <text content="  " wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={indentedName(r.name, r.indent)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={(r.resolving ? "" : r.recordType).padEnd(TYPE_W)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
        {ttlCell(r.name, r.recordType, r.ttl, r.resolving, r.followsApex, selected)}
        <text content={truncate(r.value, 38)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
        {r.followsApex ? (
          <text content=" follows apex" fg={selected ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        ) : r.pointsHere ? (
          <text content=" ◀ here" fg={selected ? theme.text : theme.good} wrapMode="none" style={{ flexShrink: 0 }} />
        ) : null}
        <box style={{ flexGrow: 1 }} />
      </>
    )
  }
}

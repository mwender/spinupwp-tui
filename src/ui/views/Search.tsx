// Global search: fuzzy-ish filtering across every server and site at once.
//
// The input is focused for the whole time this tab is active (so `inputMode`
// stays on and global shortcuts are suppressed). ↑/↓ move through results,
// Enter opens a site in the browser, Esc returns to the dashboard.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme, statusColor, statusDot } from "../../lib/theme.ts"
import { classifyStack, stackColor, stackTag } from "../../lib/stack.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Field, StatusBadge, SiteMetaCell, Spinner } from "../components.tsx"
import { isDbBackupInFlight } from "../../lib/dbBackup.ts"
import { isDbSyncInFlight } from "../../lib/dbSync.ts"
import { List, moveSelection } from "../List.tsx"
import { ServerDetail, SiteDetail } from "../Details.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { openUrl } from "../../lib/open.ts"
import { serverWebUrl, siteWebUrl } from "../../lib/spinupweb.ts"
import { useStore } from "../store.tsx"
import type { Server, Site } from "../../api/types.ts"

type Result =
  | { kind: "server"; server: Server; haystack: string }
  | { kind: "site"; site: Site; haystack: string }

// Lower score = better match. Returns null when there's no match at all.
function score(haystack: string, q: string): number | null {
  if (!q) return 0
  const i = haystack.indexOf(q)
  if (i < 0) return null
  return i === 0 ? 0 : 1 + i / 100
}

export function Search({ rows }: { rows: number }) {
  const store = useStore()
  const { servers, sites, serverById, setInputMode, setRoute, route, overlayOpen, setHealthServer, setPhpUpgradeSite, setServerActionsServer, accountSlug, localLinks, setLocalLinkSite, openLocalTerminal, openLocalUrl, sshSite, setDnsInventoryServer, setDbBackupSite, dbBackups, setDbSyncSite, dbSyncs, localSync } = store
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  // "query" = typing/filtering (input focused); "actions" = input blurred so the
  // selected result's single-key actions (o/w/u/h) fire. Tab/→ enters, ←/Esc exits.
  const [focus, setFocus] = useState<"query" | "actions">("query")
  const [flash, setFlash] = useState<string | null>(null)
  const flashMsg = (m: string) => {
    setFlash(m)
    setTimeout(() => setFlash(null), 1500)
  }

  // The input holds focus (suppressing global shortcuts) only in query mode; in
  // actions mode we blur it so single-key actions can fire.
  useEffect(() => {
    setInputMode(focus === "query")
    return () => setInputMode(false)
  }, [focus, setInputMode])

  const pool = useMemo<Result[]>(() => {
    const s: Result[] = servers.map((server) => ({
      kind: "server",
      server,
      haystack: `${server.name} ${server.ip_address ?? ""} ${server.provider_name ?? ""}`.toLowerCase(),
    }))
    const t: Result[] = sites.map((site) => ({
      kind: "site",
      site,
      haystack: `${site.domain} ${site.site_user ?? ""}`.toLowerCase(),
    }))
    return [...s, ...t]
  }, [servers, sites])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const scored = pool
      .map((r) => ({ r, sc: score(r.haystack, q) }))
      .filter((x) => x.sc !== null) as { r: Result; sc: number }[]
    scored.sort((a, b) => {
      if (a.sc !== b.sc) return a.sc - b.sc
      const an = a.r.kind === "server" ? a.r.server.name : a.r.site.domain
      const bn = b.r.kind === "server" ? b.r.server.name : b.r.site.domain
      return an.localeCompare(bn)
    })
    return scored.map((x) => x.r)
  }, [pool, query])

  // Keep the selection in range as results shrink/grow.
  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(0, results.length - 1)))
  }, [results.length])

  const isActive = route === "search" && !overlayOpen
  const current = results[Math.min(selected, Math.max(0, results.length - 1))]

  // If results vanish (e.g. the query changes), fall back to query focus.
  useEffect(() => {
    if (results.length === 0) setFocus("query")
  }, [results.length])

  const openSite = (s: Site) => {
    openUrl((s.https?.enabled ? "https://" : "http://") + s.domain)
    flashMsg(`Opening ${s.domain}…`)
  }
  const openInSpinup = (url: string) => {
    openUrl(url)
    flashMsg(accountSlug ? "Opening in SpinupWP…" : "Set accountSlug for deep links — opening dashboard")
  }

  useKeyboard((key) => {
    if (!isActive) return
    // Normalize Shift+letter (OpenTUI delivers it lowercased + a shift flag) so
    // capital actions like L (link) match in actions mode.
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw

    // Selection movement works in both modes.
    if (name === "up") return setSelected((i) => moveSelection(i, -1, results.length))
    if (name === "down") return setSelected((i) => moveSelection(i, 1, results.length))

    if (focus === "query") {
      switch (name) {
        case "return":
          if (current?.kind === "site") openSite(current.site)
          return
        case "tab":
        case "right":
          if (current) setFocus("actions")
          return
        case "escape":
          return setRoute("dashboard")
      }
      return
    }

    // actions mode (input blurred) — single-key actions on the selected result.
    switch (name) {
      case "left":
      case "escape":
        return setFocus("query")
      case "o":
        if (current?.kind === "site") openSite(current.site)
        return
      case "w":
        if (current?.kind === "site") openInSpinup(siteWebUrl(current.site.id, accountSlug))
        else if (current?.kind === "server") openInSpinup(serverWebUrl(current.server.id, accountSlug))
        return
      case "u":
        if (current?.kind === "site") setPhpUpgradeSite(current.site)
        return
      case "t":
        if (current?.kind === "site") flashMsg(openLocalTerminal(current.site.id))
        return
      case "v":
        if (current?.kind === "site") flashMsg(openLocalUrl(current.site.id))
        return
      case "L":
        if (current?.kind === "site") setLocalLinkSite(current.site)
        return
      case "s":
        if (current?.kind === "site") flashMsg(sshSite(current.site.id))
        return
      case "d":
        // DB backup uses wp-cli on the remote and downloads into the linked copy,
        // so it needs a WordPress site and a local link.
        if (current?.kind === "site") {
          if (!current.site.is_wordpress) flashMsg("Database backup needs WordPress (wp-cli) — this isn't a WP site")
          else if (!localLinks.has(current.site.id)) flashMsg("Not linked — press L to link a local copy")
          else setDbBackupSite(current.site)
        }
        return
      case "p":
        // Pull production → local: opt-in (it overwrites the local DB), and needs
        // a WordPress site + a local link.
        if (current?.kind === "site") {
          if (!localSync) flashMsg('Local sync is off — set "localSync": true in config to enable')
          else if (!current.site.is_wordpress) flashMsg("Sync needs WordPress (wp-cli) — this isn't a WP site")
          else if (!localLinks.has(current.site.id)) flashMsg("Not linked — press L to link a local copy")
          else setDbSyncSite(current.site)
        }
        return
      case "n":
        // DNS inventory scoped to this site (its domains + records) — the migrate
        // lens for moving one site to another server.
        if (current?.kind === "site") {
          const srv = serverById(current.site.server_id)
          if (srv) setDnsInventoryServer(srv, current.site.id)
        }
        return
      case "h": {
        const srv =
          current?.kind === "server"
            ? current.server
            : current?.kind === "site"
              ? serverById(current.site.server_id)
              : undefined
        if (srv) setHealthServer(srv)
        return
      }
      case "a": {
        // Server actions (reboot / restart) — on the server, or a site's server.
        const srv =
          current?.kind === "server"
            ? current.server
            : current?.kind === "site"
              ? serverById(current.site.server_id)
              : undefined
        if (srv) setServerActionsServer(srv)
        return
      }
    }
  })

  const hints =
    focus === "query"
      ? [
          { key: "↑↓", label: "select" },
          { key: "⏎", label: "open site" },
          { key: "Tab/→", label: "actions" },
          { key: "esc", label: "dashboard" },
        ]
      : current?.kind === "server"
        ? [
            { key: "↑↓", label: "select" },
            { key: "w", label: "SpinupWP" },
            { key: "a", label: "actions" },
            { key: "h", label: "health" },
            { key: "←/esc", label: "back" },
          ]
        : [
            { key: "↑↓", label: "select" },
            { key: "o", label: "open" },
            { key: "s", label: "SSH" },
            { key: "n", label: "DNS" },
            { key: "d", label: "DB backup" },
            ...(localSync ? [{ key: "p", label: "pull to local" }] : []),
            { key: "a", label: "server actions" },
            { key: "←/esc", label: "back" },
          ]

  const listRows = Math.max(3, rows - 8) // input box (3) + status bar (1) + chrome

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box style={{ flexDirection: "row", padding: 1, gap: 1 }}>
        <box
          title=" Search "
          titleColor={focus === "query" ? theme.brand : theme.textDim}
          border
          borderColor={focus === "query" ? theme.borderActive : theme.border}
          style={{ flexGrow: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1 }}
        >
          <text content="🔍 " fg={theme.brand} />
          <input
            focused={isActive && focus === "query"}
            value={query}
            placeholder="type a server name, domain, or IP…"
            onInput={setQuery}
            style={{ flexGrow: 1, backgroundColor: theme.bg, focusedBackgroundColor: theme.bg, textColor: theme.text }}
          />
          <text content={`${results.length} results`} fg={theme.textDim} />
        </box>
      </box>

      <box style={{ flexGrow: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1, paddingBottom: 1, gap: 1 }}>
        <Panel title=" Results " active={focus === "query"} flexGrow={1}>
          <List
            items={results}
            selectedIndex={selected}
            viewportRows={listRows}
            focused={focus === "query"}
            emptyText={query ? "No matches" : "Start typing to search across your whole account"}
            keyFor={(r, i) => (r.kind === "server" ? `s${r.server.id}` : `w${r.site.id}`) + i}
            renderRow={(r, sel) => {
              if (r.kind === "server") {
                return (
                  <>
                    <text content="SRV " fg={sel ? theme.text : theme.purple} style={{ flexShrink: 0 }} />
                    <text content={statusDot(r.server.connection_status) + " "} fg={statusColor(r.server.connection_status)} style={{ flexShrink: 0 }} />
                    <text content={truncate(r.server.name, 44)} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1, marginRight: 1 }} />
                    {r.server.reboot_required && <text content="↻rbt " fg={sel ? theme.text : theme.warn} style={{ flexShrink: 0 }} />}
                    <text content={r.server.provider_name ?? ""} fg={sel ? theme.text : theme.textFaint} style={{ flexShrink: 0 }} />
                  </>
                )
              }
              return (
                <>
                  <text content="SITE" fg={sel ? theme.text : theme.accent} style={{ flexShrink: 0 }} />
                  <text content={" " + statusDot(r.site.status) + " "} fg={statusColor(r.site.status)} style={{ flexShrink: 0 }} />
                  <text content={truncate(r.site.domain, 44)} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1, marginRight: 1 }} />
                  {(() => {
                    // Sync (destructive) takes visual priority over a plain backup.
                    const sy = dbSyncs.get(r.site.id)
                    if (sy && isDbSyncInFlight(sy))
                      return (
                        <box style={{ flexDirection: "row", flexShrink: 0 }}>
                          <Spinner color={sel ? theme.text : theme.brand} interval={120} />
                          <text content="⇣ " fg={sel ? theme.text : theme.warn} wrapMode="none" />
                        </box>
                      )
                    if (sy?.stage === "done") return <text content="⇣✓ " fg={sel ? theme.text : theme.good} wrapMode="none" style={{ flexShrink: 0 }} />
                    if (sy?.stage === "error") return <text content="⇣! " fg={sel ? theme.text : theme.bad} wrapMode="none" style={{ flexShrink: 0 }} />
                    const b = dbBackups.get(r.site.id)
                    if (b && isDbBackupInFlight(b))
                      return (
                        <box style={{ flexDirection: "row", flexShrink: 0 }}>
                          <Spinner color={sel ? theme.text : theme.brand} interval={120} />
                          <text content="⬇ " fg={sel ? theme.text : theme.warn} wrapMode="none" />
                        </box>
                      )
                    if (b?.stage === "done") return <text content="⬇✓ " fg={sel ? theme.text : theme.good} wrapMode="none" style={{ flexShrink: 0 }} />
                    if (b?.stage === "error") return <text content="⬇! " fg={sel ? theme.text : theme.bad} wrapMode="none" style={{ flexShrink: 0 }} />
                    return null
                  })()}
                  <SiteMetaCell
                    linked={localLinks.has(r.site.id)}
                    updates={(r.site.wp_plugin_updates || 0) + (r.site.wp_theme_updates || 0) + (r.site.wp_core_update ? 1 : 0)}
                    selected={sel}
                  />
                  <text content={stackTag(classifyStack(r.site))} fg={stackColor(classifyStack(r.site), sel)} style={{ flexShrink: 0 }} />
                </>
              )
            }}
          />
        </Panel>

        <Panel title={focus === "actions" ? " Actions " : " Details "} active={focus === "actions"} width={44}>
          {!current ? (
            <text content="No selection" fg={theme.textFaint} />
          ) : focus === "actions" ? (
            <ActionsCard
              result={current}
              serverName={current.kind === "site" ? (serverById(current.site.server_id)?.name ?? "—") : current.server.name}
              localSync={localSync}
            />
          ) : current.kind === "server" ? (
            <ServerDetail server={current.server} siteCount={store.sitesForServer(current.server.id).length} />
          ) : (
            <SiteDetail site={current.site} serverName={serverById(current.site.server_id)?.name ?? "—"} />
          )}
        </Panel>
      </box>

      <StatusBar hints={hints} message={flash ?? undefined} showGlobal={false} />
    </box>
  )
}

// Site Control panel shown in the Details pane while in "actions" focus. Groups
// the live single-key actions (Open / Remote / Local / Server) so the suite is
// discoverable and scales as more actions land. A site gets the full set; a
// server gets just the open + server actions.
type ActionGroup = { title: string; items: [string, string][] }

// The DB backup/sync use wp-cli, so they only apply to WordPress sites — omitted
// for non-WP sites (their `d`/`p` keypresses are also guarded in the handler). DNS
// (`n`) and the rest apply to any site.
function siteGroups(isWordpress: boolean, localSync: boolean): ActionGroup[] {
  const remote: [string, string][] = [
    ["s", "SSH into the site"],
    ["n", "DNS records (migrate lens)"],
  ]
  if (isWordpress) {
    remote.push(["d", "Download DB backup"])
    if (localSync) remote.push(["p", "Pull production DB to local"])
  }
  remote.push(["u", "Upgrade PHP version"])
  return [
    { title: "Open", items: [["o", "Open site in browser"], ["w", "Open in SpinupWP"]] },
    { title: "Remote", items: remote },
    {
      title: "Local",
      items: [
        ["t", "Open working copy in a terminal"],
        ["v", "Open the local URL"],
        ["L", "Link / edit local copy"],
      ],
    },
    { title: "Server", items: [["a", "Server actions (reboot / restart)"], ["h", "Server health"]] },
  ]
}

const SERVER_GROUPS: ActionGroup[] = [
  { title: "Open", items: [["w", "Open in SpinupWP"]] },
  { title: "Server", items: [["a", "Server actions (reboot / restart)"], ["h", "Server health"]] },
]

function ActionsCard({ result, serverName, localSync }: { result: Result; serverName: string; localSync: boolean }) {
  const isSite = result.kind === "site"
  const name = isSite ? result.site.domain : result.server.name
  const status = isSite ? result.site.status : result.server.connection_status
  const groups = isSite ? siteGroups(result.site.is_wordpress, localSync) : SERVER_GROUPS
  return (
    <box style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row" }}>
        <text content={truncate(name, 30)} fg={theme.text} attributes={1} wrapMode="none" />
        <box style={{ flexGrow: 1 }} />
        <StatusBadge status={status} />
      </box>
      {isSite ? (
        <>
          <text content={(result.site.https?.enabled ? "https://" : "http://") + result.site.domain} fg={theme.accent} wrapMode="none" />
          <box style={{ height: 1 }} />
          <Field label="Server" value={truncate(serverName, 28)} labelWidth={8} />
          <Field label="PHP" value={result.site.php_version ?? "—"} labelWidth={8} />
          <Field label="Stack" value={classifyStack(result.site)} valueColor={stackColor(classifyStack(result.site))} labelWidth={8} />
        </>
      ) : (
        <>
          <text content={result.server.ip_address ?? "—"} fg={theme.accent} wrapMode="none" />
          <box style={{ height: 1 }} />
          <Field label="Provider" value={result.server.provider_name ?? "—"} labelWidth={9} />
          <Field label="Region" value={result.server.region ?? "—"} labelWidth={9} />
        </>
      )}
      <box style={{ height: 1 }} />
      <text content="Site Control" fg={theme.accent} />
      {groups.map((group) => (
        <box key={group.title} style={{ flexDirection: "column" }}>
          <text content={group.title.toUpperCase()} fg={theme.textFaint} wrapMode="none" />
          {group.items.map(([k, label]) => (
            <box key={k} style={{ flexDirection: "row" }}>
              <text content={` ${k} `} fg={theme.bg} bg={theme.brandDim} style={{ flexShrink: 0 }} />
              <text content={`  ${label}`} fg={theme.text} wrapMode="none" />
            </box>
          ))}
        </box>
      ))}
      <box style={{ height: 1 }} />
      <text content="↑↓ select · ←/Esc back to search" fg={theme.textFaint} wrapMode="none" />
    </box>
  )
}

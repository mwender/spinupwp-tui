// A site's installed plugins & themes (full-screen overlay).
//
// Opened from the Browser with `p`. Runs `wp plugin list` / `wp theme list` over
// SSH (read-only) and renders them as one combined, scrollable list with PLUGINS
// and THEMES section headers — the `wp plugin list` detail (current version +
// update-available) the SpinupWP API never exposes. Esc/q/p closes it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Spinner, Centered } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { fetchWpInventory, updateCount, type WpInventory as Inventory, type WpItem } from "../../lib/wpInventory.ts"

// A flattened row: a section header, or one plugin/theme item.
type Row =
  | { kind: "header"; label: string; count: number; updates: number }
  | { kind: "item"; item: WpItem }

function buildRows(inv: Inventory): Row[] {
  const rows: Row[] = []
  rows.push({ kind: "header", label: "PLUGINS", count: inv.plugins.length, updates: updateCount(inv.plugins) })
  for (const item of inv.plugins) rows.push({ kind: "item", item })
  rows.push({ kind: "header", label: "THEMES", count: inv.themes.length, updates: updateCount(inv.themes) })
  for (const item of inv.themes) rows.push({ kind: "item", item })
  return rows
}

// Active items get a filled dot; inactive an open one; must-use/dropin a diamond.
function statusGlyph(status: string): { glyph: string; color: string } {
  if (status === "inactive") return { glyph: "○", color: theme.textFaint }
  if (status === "must-use" || status === "dropin") return { glyph: "◆", color: theme.textDim }
  return { glyph: "●", color: theme.good } // active / active-network / parent
}

function ItemRow({ item, selected }: { item: WpItem; selected: boolean }) {
  const s = statusGlyph(item.status)
  const hasUpdate = item.update === "available"
  return (
    <>
      <text content=" " style={{ flexShrink: 0 }} />
      <text content={`${s.glyph} `} fg={selected ? theme.text : s.color} wrapMode="none" style={{ flexShrink: 0 }} />
      <text
        content={truncate(item.name, 34)}
        fg={selected ? theme.text : theme.text}
        wrapMode="none"
        style={{ flexGrow: 1, flexShrink: 1 }}
      />
      <text content={(item.status || "—").padEnd(10)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
      <text content={(item.version || "—").padEnd(12)} fg={selected ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
      {hasUpdate ? (
        <text content={`→ ${item.updateVersion ?? "update"}`} fg={selected ? theme.text : theme.update} wrapMode="none" style={{ flexShrink: 0 }} />
      ) : (
        <text content="✓ current" fg={selected ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      )}
      <text content=" " style={{ flexShrink: 0 }} />
    </>
  )
}

function HeaderRow({ row }: { row: Extract<Row, { kind: "header" }> }) {
  return (
    <>
      <text content={` ${row.label} `} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
      <text content={`(${row.count})`} fg={theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
      {row.updates > 0 ? (
        <text content={`${row.updates} update${row.updates === 1 ? "" : "s"} `} fg={theme.update} wrapMode="none" style={{ flexShrink: 0 }} />
      ) : (
        <text content="up to date " fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      )}
    </>
  )
}

export function WpInventory() {
  const { wpInventorySite, setWpInventorySite, serverById, sshUser } = useStore()
  const { height } = useTerminalDimensions()
  const site = wpInventorySite
  const server = useMemo(() => serverById(site?.server_id), [serverById, site?.server_id])

  const [inv, setInv] = useState<Inventory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState("")
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(0)
  const busy = useRef(false)

  const load = useCallback(async () => {
    if (!site || !server || busy.current) return
    busy.current = true
    setLoading(true)
    const res = await fetchWpInventory(server, site, sshUser)
    busy.current = false
    setTarget(res.target)
    setLoading(false)
    if (res.ok) {
      setInv(res.inventory)
      setError(null)
    } else {
      setError(res.error)
      setInv(null)
    }
  }, [site, server, sshUser])

  useEffect(() => {
    setInv(null)
    setError(null)
    setSelected(0)
    void load()
  }, [load])

  const rows = useMemo(() => (inv ? buildRows(inv) : []), [inv])

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q" || key.name === "p") return setWpInventorySite(null)
    if (key.name === "r") return void load()
    if (rows.length === 0) return
    if (key.name === "up" || key.name === "k") setSelected((i) => moveSelection(i, -1, rows.length))
    else if (key.name === "down" || key.name === "j") setSelected((i) => moveSelection(i, 1, rows.length))
    else if (key.name === "g") setSelected(0)
    else if (key.name === "G") setSelected(rows.length - 1)
  })

  if (!site) return null

  const totalUpdates = inv ? updateCount(inv.plugins) + updateCount(inv.themes) : 0
  const listRows = Math.max(3, height - 4)

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
        <text content="⧉ Plugins & Themes  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        {inv && totalUpdates > 0 ? (
          <text content={`  ↑${totalUpdates} update${totalUpdates === 1 ? "" : "s"}`} fg={theme.update} wrapMode="none" style={{ flexShrink: 0 }} />
        ) : null}
        <box style={{ flexGrow: 1 }} />
        {loading && <Spinner interval={120} />}
        <text content={target ? `  ${target}` : "  connecting…"} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      </box>

      {loading && !inv && !error ? (
        <Centered>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={`  Reading plugins & themes over SSH…`} fg={theme.textDim} />
          </box>
        </Centered>
      ) : error ? (
        <Centered>
          <box
            title=" Couldn't read this site "
            titleColor={theme.bad}
            border
            borderColor={theme.bad}
            style={{ flexDirection: "column", width: 72, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
          >
            <text content={`✕ ${error}`} fg={theme.bad} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content={`Tried:  ssh ${target}`} fg={theme.textDim} wrapMode="none" />
            <text content="Reads via your local SSH keys as the site user (no password prompts)." fg={theme.textFaint} wrapMode="none" />
            <text content={`Verify first:  ssh ${target} 'wp --path=/sites/${site.domain}/files plugin list'`} fg={theme.textFaint} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press r to retry · Esc to close" fg={theme.textDim} />
          </box>
        </Centered>
      ) : inv ? (
        <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
          <List
            items={rows}
            selectedIndex={selected}
            viewportRows={listRows}
            focused
            keyFor={(_r, i) => i}
            emptyText="No plugins or themes found."
            renderRow={(row, isSel) =>
              row.kind === "header" ? <HeaderRow row={row} /> : <ItemRow item={row.item} selected={isSel} />
            }
          />
        </box>
      ) : null}

      <StatusBar
        hints={[
          { key: "↑↓/jk", label: "scroll" },
          { key: "r", label: "refresh" },
          { key: "esc/q", label: "close" },
        ]}
        message={inv ? `${inv.plugins.length} plugins · ${inv.themes.length} themes` : undefined}
        showGlobal={false}
      />
    </box>
  )
}

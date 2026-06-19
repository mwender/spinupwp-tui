// Small shared presentational components used across views.

import { useEffect, useState, type ReactNode } from "react"
import { theme, statusColor, statusDot } from "../lib/theme.ts"
import { isUpgradeInFlight, type PhpUpgradeProgress } from "./store.tsx"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// An animated braille spinner. `interval` ms per frame.
export function Spinner({ color = theme.brand, interval = 80 }: { color?: string; interval?: number }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), interval)
    return () => clearInterval(id)
  }, [interval])
  return <text content={SPINNER_FRAMES[frame]} fg={color} />
}

// A bordered panel with a consistent title style. `active` highlights the border.
export function Panel({
  title,
  active = false,
  children,
  flexGrow,
  width,
  bottomTitle,
  style,
}: {
  title?: string
  active?: boolean
  children?: ReactNode
  flexGrow?: number
  width?: number | `${number}%`
  bottomTitle?: string
  style?: Record<string, unknown>
}) {
  return (
    <box
      title={title}
      titleColor={active ? theme.brand : theme.textDim}
      bottomTitle={bottomTitle}
      bottomTitleAlignment="right"
      border
      borderColor={active ? theme.borderActive : theme.border}
      flexGrow={flexGrow}
      width={width}
      style={{ flexDirection: "column", paddingLeft: 1, paddingRight: 1, ...style }}
    >
      {children}
    </box>
  )
}

// A label / value row used in detail panels. Label is dimmed and fixed-width.
export function Field({
  label,
  value,
  valueColor = theme.text,
  labelWidth = 16,
}: {
  label: string
  value: ReactNode
  valueColor?: string
  labelWidth?: number
}) {
  return (
    <box style={{ flexDirection: "row" }}>
      <text content={label.padEnd(labelWidth)} fg={theme.textDim} />
      {typeof value === "string" || typeof value === "number" ? (
        <text content={String(value)} fg={valueColor} />
      ) : (
        value
      )}
    </box>
  )
}

// A colored status dot followed by its label (e.g. "● connected").
export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  const color = statusColor(status)
  return (
    <box style={{ flexDirection: "row" }}>
      <text content={statusDot(status) + " "} fg={color} />
      <text content={label ?? status ?? "unknown"} fg={color} />
    </box>
  )
}

// A small inline pill, e.g. for "reboot required" warnings.
export function Pill({ text, color }: { text: string; color: string }) {
  return <text content={` ${text} `} fg={theme.bg} bg={color} />
}

// Trailing PHP-version cell for a site row. Normally the version string; while a
// PHP upgrade is in flight it shows a spinner + the target (e.g. "⠹→8.3"); a
// failed upgrade flags the version with "⬆!". Shared by the Servers & Stacks rows.
export function PhpVersionCell({
  version,
  upgrade,
  selected,
  eol = false,
}: {
  version: string | null | undefined
  upgrade?: PhpUpgradeProgress
  selected?: boolean
  eol?: boolean
}) {
  if (upgrade && isUpgradeInFlight(upgrade)) {
    return (
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        <Spinner color={selected ? theme.text : theme.brand} interval={120} />
        <text content={`→${upgrade.target}`} fg={selected ? theme.text : theme.warn} wrapMode="none" />
      </box>
    )
  }
  if (upgrade?.status === "failed") {
    return <text content={`${version ?? "—"} ⬆!`} fg={selected ? theme.text : theme.bad} style={{ flexShrink: 0 }} />
  }
  return (
    <text
      content={version ?? "—"}
      fg={selected ? theme.text : eol ? theme.bad : theme.textFaint}
      style={{ flexShrink: 0 }}
    />
  )
}

// Glanceable per-row meta for a site list, shared across the Servers, Stacks,
// and Search rows so the convention is identical everywhere:
//   ◆  = a local working copy is linked   (blank keeps columns aligned)
//   ↑N = N pending WordPress updates
// Presence-only by design — the inspector strip shows the full detail (path /
// URL / on-disk validity) for the focused row.
export function SiteMetaCell({ linked, updates, selected = false }: { linked: boolean; updates: number; selected?: boolean }) {
  return (
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      <text content={linked ? "◆ " : "  "} fg={selected ? theme.text : theme.good} wrapMode="none" />
      {updates > 0 ? <text content={`↑${updates} `} fg={selected ? theme.text : theme.warn} wrapMode="none" /> : null}
    </box>
  )
}

// Centered helper text, often for empty/loading states inside a panel.
export function Centered({ children }: { children: ReactNode }) {
  return (
    <box style={{ flexGrow: 1, justifyContent: "center", alignItems: "center", flexDirection: "column" }}>
      {children}
    </box>
  )
}

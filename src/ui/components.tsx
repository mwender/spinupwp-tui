// Small shared presentational components used across views.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useKeyboard, usePaste } from "@opentui/react"
import { theme, statusColor, statusDot } from "../lib/theme.ts"
import { middleTruncate } from "../lib/format.ts"
import { isUpgradeInFlight, type PhpUpgradeProgress } from "./store.tsx"

// Shorten a home-relative absolute path for display (~/project/sql/file.sql.gz).
export function shortPath(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(home + "/") ? "~/" + path.slice(home.length + 1) : path
}

// A filesystem destination shown as two lines — folder (dim, middle-truncated)
// above the filename (colored, middle-truncated) — so the filename always stays
// readable instead of being clipped off the end of one long line.
export function DestPath({ path, fileColor, width = 62 }: { path: string; fileColor: string; width?: number }) {
  const s = shortPath(path)
  const i = s.lastIndexOf("/")
  const dir = i < 0 ? "" : s.slice(0, i + 1)
  const file = i < 0 ? s : s.slice(i + 1)
  return (
    <box style={{ flexDirection: "column" }}>
      {dir ? <text content={`  ${middleTruncate(dir, width)}`} fg={theme.textDim} wrapMode="none" /> : null}
      <text content={`  ${middleTruncate(file, width)}`} fg={fileColor} wrapMode="none" />
    </box>
  )
}

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

// A masked text field for secrets/tokens. OpenTUI's <input> keeps its own editor
// buffer and has no masking/password mode, so a controlled "show dots" value
// fights that buffer (the secret flashes, then the field clears). Instead this
// owns the value itself: it captures keypresses + paste while focused and renders
// only dots — the secret is never drawn in cleartext. We deliberately do NOT use
// <input> here. Editing is append/backspace at the end (paste-and-go for tokens).
const MASK = "•"
export function SecretInput({
  value,
  onChange,
  focused,
  placeholder,
  onSubmit,
}: {
  value: string
  onChange: (v: string) => void
  focused?: boolean
  placeholder?: string
  onSubmit?: () => void
}) {
  // Mirror the value in a ref so a rapid burst of key events (or a paste split
  // into per-char events) accumulates instead of each handler closing over a
  // stale `value` and overwriting the last — we update the ref synchronously.
  const valueRef = useRef(value)
  valueRef.current = value
  const setValue = (next: string) => {
    valueRef.current = next
    onChange(next)
  }

  useKeyboard((key) => {
    if (!focused) return
    const name = key.name ?? ""
    if (name === "return" || name === "enter") return onSubmit?.()
    if (name === "backspace" || name === "delete") return setValue(valueRef.current.slice(0, -1))
    // Let the host overlay handle navigation/dismiss keys.
    if (["up", "down", "left", "right", "tab", "escape"].includes(name)) return
    if (key.ctrl || key.meta) return
    // A single printable character — append it.
    const seq: string = (key as { sequence?: string; raw?: string }).sequence ?? (key as { raw?: string }).raw ?? ""
    if (seq.length === 1 && seq >= " ") setValue(valueRef.current + seq)
  })

  usePaste((event: { bytes?: Uint8Array }) => {
    if (!focused) return
    const text = event?.bytes ? new TextDecoder().decode(event.bytes) : ""
    const cleaned = text.replace(/[\r\n]+/g, "") // tokens are one line; drop any newlines
    if (cleaned) setValue(valueRef.current + cleaned)
  })

  const hasValue = value.length > 0
  const content = hasValue
    ? MASK.repeat(value.length) + (focused ? "▏" : "")
    : (focused ? "▏ " : "") + (placeholder ?? "")
  return (
    <box style={{ height: 1, flexDirection: "row", backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1 }}>
      <text content={content} fg={hasValue ? theme.text : theme.textFaint} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
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

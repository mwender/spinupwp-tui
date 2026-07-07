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

const SPARKLE_FRAMES = ["✦", "✧", "✶", "✧"]

// A gentle twinkling glyph for drawing the eye to a notice (e.g. an available
// update) without the urgency of a spinner.
export function Sparkle({ color = theme.brand, interval = 360 }: { color?: string; interval?: number }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPARKLE_FRAMES.length), interval)
    return () => clearInterval(id)
  }, [interval])
  return <text content={SPARKLE_FRAMES[frame]} fg={color} />
}

// A vertical checklist of stages that fills in as work progresses: completed
// rows get a green ✓, the in-flight row spins, not-yet-reached rows are faint
// ○, and a failed row gets a red ✕. A `waiting` row (paused for the user to act)
// gets an amber ❯ — distinct from the spinner so it reads as "your turn", not
// "system working". Used by the DB backup/sync + vanity overlays.
export type StepState = "done" | "active" | "pending" | "failed" | "waiting"
export interface StepRow {
  label: string
  state: StepState
  detail?: string // optional trailing text (e.g. a timer), shown dim after the label
}

export function Steps({ rows }: { rows: StepRow[] }) {
  return (
    <box style={{ flexDirection: "column" }}>
      {rows.map((r, i) => (
        <box key={i} style={{ flexDirection: "row", height: 1 }}>
          {r.state === "active" ? (
            <Spinner color={theme.brand} />
          ) : (
            <text
              content={r.state === "done" ? "✓" : r.state === "failed" ? "✕" : r.state === "waiting" ? "❯" : "○"}
              fg={r.state === "done" ? theme.good : r.state === "failed" ? theme.bad : r.state === "waiting" ? theme.warn : theme.textFaint}
            />
          )}
          <text
            content={` ${r.label}`}
            fg={r.state === "pending" ? theme.textFaint : r.state === "waiting" ? theme.warn : theme.text}
            wrapMode="none"
          />
          {r.detail ? <text content={`  ${r.detail}`} fg={theme.textDim} wrapMode="none" /> : null}
        </box>
      ))}
    </box>
  )
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
export function SiteMetaCell({
  linked,
  updates,
  personalKey = false,
  machineKey = false,
  selected = false,
}: {
  linked: boolean
  updates: number
  personalKey?: boolean // 👤 your key is on the site
  machineKey?: boolean // 🔑 the spinup-tui machine key is on the site
  selected?: boolean
}) {
  const keyMark = (personalKey ? "👤" : "") + (machineKey ? "🔑" : "")
  return (
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      <text content={linked ? "◆ " : "  "} fg={selected ? theme.text : theme.good} wrapMode="none" />
      {keyMark ? <text content={keyMark + " "} wrapMode="none" /> : null}
      {updates > 0 ? <text content={`↑${updates} `} fg={selected ? theme.text : theme.warn} wrapMode="none" /> : null}
    </box>
  )
}

// The main Sites-row status column: a FIXED-slot capability strip so the stack /
// PHP columns after it line up across every row (unlike SiteMetaCell, whose
// present-or-absent marks shove later columns around). Each slot reserves the
// same width whether or not the capability is on — a lit letter when on, a faint
// "·" when off — giving a scannable H/C/B matrix down the list:
//   ◆   local working copy linked
//   👤🔑 personal / machine SSH key on the site (2-emoji-wide slot, always)
//   H   HTTPS enabled   C  page cache enabled   B  backups (files or db) enabled
//   ↑N  N pending WordPress updates
// Detail (which keys, backup schedule, etc.) lives in the Details pane / context
// strip; this strip is glance-only.
export function SiteStatusColumn({
  linked,
  personalKey = false,
  machineKey = false,
  https,
  cache,
  backup,
  updates,
  selected = false,
}: {
  linked: boolean
  personalKey?: boolean
  machineKey?: boolean
  https: boolean
  cache: boolean
  backup: boolean
  updates: number
  selected?: boolean
}) {
  const onColor = selected ? theme.text : theme.good
  const offColor = selected ? theme.textDim : theme.textFaint
  // A fixed-width toggle slot: the letter when on, a faint dot when off.
  const flag = (label: string, on: boolean) => (
    <text content={`${on ? label : "·"} `} fg={on ? onColor : offColor} wrapMode="none" style={{ flexShrink: 0 }} />
  )
  // Key slot is always two emoji-cells wide (pad the empties) so H/C/B never shift.
  const keyCell = (personalKey ? "👤" : "  ") + (machineKey ? "🔑" : "  ")
  return (
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      <text content={`${linked ? "◆" : " "} `} fg={selected ? theme.text : theme.good} wrapMode="none" style={{ flexShrink: 0 }} />
      <text content={`${keyCell} `} wrapMode="none" style={{ flexShrink: 0 }} />
      {flag("H", https)}
      {flag("C", cache)}
      {flag("B", backup)}
      <text
        content={updates > 0 ? `↑${updates} `.padEnd(4) : "    "}
        fg={selected ? theme.text : theme.warn}
        wrapMode="none"
        style={{ flexShrink: 0 }}
      />
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
  width,
}: {
  value: string
  onChange: (v: string) => void
  focused?: boolean
  placeholder?: string
  onSubmit?: () => void
  width?: number // fixed box width; omit for content-sized (existing call sites)
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

  // The field always keeps a visible bgAlt box (same as the regular text inputs);
  // focus is carried by the green ❯ marker + caret, not by dimming the box.
  const hasValue = value.length > 0
  return (
    <box
      style={{
        height: 1,
        flexDirection: "row",
        backgroundColor: theme.bgAlt,
        paddingLeft: 1,
        paddingRight: 1,
        ...(width != null ? { width } : {}),
      }}
    >
      <text content={focused ? "❯ " : "  "} fg={focused ? theme.brand : theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      {hasValue ? <text content={MASK.repeat(value.length)} fg={theme.text} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
      {focused ? <text content="▏" fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} /> : null}
      {!hasValue ? (
        <text content={placeholder ?? ""} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
      ) : null}
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

// A grouped, key-chipped action legend ("Site Control" / "Server Control"): a heading,
// then dim group titles each over a list of `key → outcome` rows. Shared by the Search
// actions pane and the Servers detail pane so the suite reads the same everywhere.
export type ActionGroup = { title: string; items: [string, string][] }
export function ControlPanel({ heading, groups }: { heading: string; groups: ActionGroup[] }) {
  return (
    <box style={{ flexDirection: "column" }}>
      <text content={heading} fg={theme.accent} />
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
    </box>
  )
}

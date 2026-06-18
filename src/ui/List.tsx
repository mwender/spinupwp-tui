// A generic, keyboard-navigable, windowed list.
//
// The parent owns `selectedIndex` (so it can react to selection changes); this
// component owns only the scroll offset, which it keeps in sync so the selected
// row stays visible. Rendering each row is delegated to `renderRow`, giving each
// view full control over columns and colors.

import { useEffect, useState, type ReactNode } from "react"
import { theme } from "../lib/theme.ts"

export interface ListProps<T> {
  items: T[]
  selectedIndex: number
  // Number of rows available to render (the viewport height in rows).
  viewportRows: number
  renderRow: (item: T, selected: boolean, index: number) => ReactNode
  // Whether this list currently has focus (affects the selection highlight color).
  focused?: boolean
  emptyText?: string
  // Optional fixed key extractor; defaults to index.
  keyFor?: (item: T, index: number) => string | number
}

export function List<T>({
  items,
  selectedIndex,
  viewportRows,
  renderRow,
  focused = true,
  emptyText = "Nothing here.",
  keyFor,
}: ListProps<T>) {
  const [offset, setOffset] = useState(0)
  const rows = Math.max(1, viewportRows)

  // Keep the selected row within the visible window [offset, offset+rows).
  useEffect(() => {
    setOffset((cur) => {
      const maxOffset = Math.max(0, items.length - rows)
      let next = cur
      if (selectedIndex < cur) next = selectedIndex
      else if (selectedIndex >= cur + rows) next = selectedIndex - rows + 1
      return Math.min(Math.max(0, next), maxOffset)
    })
  }, [selectedIndex, rows, items.length])

  if (items.length === 0) {
    return (
      <box style={{ flexGrow: 1, justifyContent: "center", alignItems: "center" }}>
        <text content={emptyText} fg={theme.textFaint} />
      </box>
    )
  }

  const start = Math.min(offset, Math.max(0, items.length - rows))
  const visible = items.slice(start, start + rows)
  const hasAbove = start > 0
  const hasBelow = start + rows < items.length

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      {visible.map((item, i) => {
        const index = start + i
        const selected = index === selectedIndex
        return (
          <box
            key={keyFor ? keyFor(item, index) : index}
            style={{
              flexDirection: "row",
              height: 1,
              backgroundColor: selected ? (focused ? theme.selectedBg : theme.bgAlt) : undefined,
            }}
          >
            {renderRow(item, selected, index)}
          </box>
        )
      })}
      {/* Scroll affordance: show counts when the list overflows the viewport. */}
      {(hasAbove || hasBelow) && (
        <box style={{ flexDirection: "row", justifyContent: "flex-end", height: 1 }}>
          <text
            content={`${hasAbove ? "↑" : " "}${hasBelow ? "↓" : " "} ${selectedIndex + 1}/${items.length}`}
            fg={theme.textFaint}
          />
        </box>
      )}
    </box>
  )
}

// Shared helper for list views: clamp/move a selection index with wrap-around.
export function moveSelection(current: number, delta: number, length: number): number {
  if (length === 0) return 0
  return (current + delta + length) % length
}

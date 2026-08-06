// Renders the toast queue from ./toast.ts. See that file for why this is
// first-party instead of a dependency. Mounted last in App.tsx so it draws
// over every view + overlay; top-right, nudged clear of the 2-row Header.
// It never takes keyboard focus.

import { useSyncExternalStore } from "react"
import { theme } from "../lib/theme.ts"
import { getToasts, subscribeToasts } from "./toast.ts"

const TOAST_WIDTH = 60

export function ToastStack() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts)

  if (toasts.length === 0) return null

  return (
    <box style={{ position: "absolute", top: 2, right: 2, flexDirection: "column", gap: 1, zIndex: 300 }}>
      {toasts.map((t) => (
        <box
          key={t.id}
          border
          borderColor={theme.good}
          backgroundColor={theme.bgPanel}
          style={{ flexDirection: "row", gap: 1, maxWidth: TOAST_WIDTH, paddingLeft: 1, paddingRight: 1 }}
        >
          <text content="✓" fg={theme.good} />
          <text content={t.message} fg={theme.text} />
        </box>
      ))}
    </box>
  )
}

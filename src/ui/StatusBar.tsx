// Bottom status bar showing context-sensitive key hints plus always-present
// global hints (help / quit). Views render their own StatusBar so hints can be
// contextual; the global set is appended automatically for consistency.

import { theme } from "../lib/theme.ts"

export interface KeyHint {
  key: string
  label: string
}

const GLOBAL_HINTS: KeyHint[] = [
  { key: "r", label: "refresh" },
  { key: "i", label: "explain" },
  { key: "?", label: "help" },
  { key: "q", label: "quit" },
]

function HintGroup({ hints, dim = false }: { hints: KeyHint[]; dim?: boolean }) {
  return (
    <>
      {hints.map((h, i) => (
        <box key={i} style={{ flexDirection: "row" }}>
          <text content={` ${h.key} `} fg={theme.bg} bg={dim ? theme.textFaint : theme.brandDim} />
          <text content={` ${h.label}  `} fg={theme.textDim} />
        </box>
      ))}
    </>
  )
}

export function StatusBar({
  hints,
  message,
  messageColor,
  showGlobal = true,
}: {
  hints: KeyHint[]
  message?: string
  messageColor?: string
  showGlobal?: boolean
}) {
  return (
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
      <HintGroup hints={hints} />
      {message && <text content={message} fg={messageColor ?? theme.brand} />}
      <box style={{ flexGrow: 1 }} />
      {showGlobal && <HintGroup hints={GLOBAL_HINTS} dim />}
    </box>
  )
}

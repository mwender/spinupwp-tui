// "What's new" overlay — shows once after Spinup updates to a new version,
// rendering the GitHub release notes for the exact version now running (see
// ../../lib/releaseNotes.ts). Auto-opens when store.releaseNotesInfo is set
// (no keypress needed to open it); dismissed with any key, which persists the
// running version as "seen" so it never shows again for this version.

import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { formatReleaseNotesBody } from "../../lib/releaseNotes.ts"
import { useStore } from "../store.tsx"

export function ReleaseNotes() {
  const { releaseNotesInfo, dismissReleaseNotes } = useStore()
  const { width, height } = useTerminalDimensions()

  // One-shot announcement, not a navigable view — any key closes it.
  useKeyboard(() => dismissReleaseNotes())

  if (!releaseNotesInfo) return null

  const boxWidth = Math.min(width - 4, 100)
  const maxRows = Math.max(6, height - 8)
  const allLines = formatReleaseNotesBody(releaseNotesInfo.body)
  const truncated = allLines.length > maxRows
  const lines = truncated ? allLines.slice(0, maxRows - 1) : allLines
  const boxHeight = Math.min(lines.length + (truncated ? 1 : 0), maxRows) + 4

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        justifyContent: "center",
        alignItems: "center",
        zIndex: 100,
      }}
    >
      <box
        title={` ✦ What's new in ${releaseNotesInfo.title} `}
        titleColor={theme.update}
        bottomTitle=" press any key to close "
        bottomTitleAlignment="center"
        border
        borderColor={theme.borderActive}
        backgroundColor={theme.bgPanel}
        style={{ flexDirection: "column", width: boxWidth, height: boxHeight, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
      >
        {lines.map((line, i) => {
          if (line.kind === "blank") return <box key={i} style={{ height: 1 }} />
          if (line.kind === "heading") return <text key={i} content={line.content} fg={theme.accent} attributes={1} />
          if (line.kind === "bullet") return <text key={i} content={"• " + line.content} fg={theme.text} />
          return <text key={i} content={line.content} fg={theme.text} />
        })}
        {truncated ? <text content="…" fg={theme.textFaint} /> : null}
      </box>
    </box>
  )
}

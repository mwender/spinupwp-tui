// "What's new" overlay — shows once after Spinup updates to a new version,
// rendering the GitHub release notes for the exact version now running (see
// ../../lib/releaseNotes.ts). Auto-opens when store.releaseNotesInfo is set
// (no keypress needed to open it); dismissed with any key, which persists the
// running version as "seen" so it never shows again for this version.

import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { formatReleaseNotesBody, type NoteLine } from "../../lib/releaseNotes.ts"
import { useStore } from "../store.tsx"

// Rough estimate of how many VISUAL rows a line will wrap to at a given
// content width — needed because the box's height must be based on wrapped
// rows, not logical lines (a single long bullet can span 3-4 rows).
function estimatedRows(content: string, width: number): number {
  return Math.max(1, Math.ceil(content.length / Math.max(1, width)))
}

export function ReleaseNotes() {
  const { releaseNotesInfo, dismissReleaseNotes } = useStore()
  const { width, height } = useTerminalDimensions()

  // One-shot announcement, not a navigable view — any key closes it.
  useKeyboard(() => dismissReleaseNotes())

  if (!releaseNotesInfo) return null

  const boxWidth = Math.min(width - 4, 100)
  const contentWidth = boxWidth - 6 // border(2) + paddingLeft/Right(2+2)
  const maxVisualRows = Math.max(8, height - 8)

  // Fit as many logical lines as fit within maxVisualRows of WRAPPED content —
  // the box itself is left unsized (grows to fit, like every other overlay in
  // this app) rather than pre-computed, which is what caused the overlap bug:
  // a fixed height sized to logical-line count was too short once bullets
  // actually word-wrapped, so later lines drew over still-wrapping earlier ones.
  let usedRows = 0
  let truncated = false
  const lines: NoteLine[] = []
  for (const line of formatReleaseNotesBody(releaseNotesInfo.body)) {
    const w = line.kind === "bullet" ? contentWidth - 2 : contentWidth
    const rows = line.kind === "blank" ? 1 : estimatedRows(line.content, w)
    if (usedRows + rows > maxVisualRows) {
      truncated = true
      break
    }
    usedRows += rows
    lines.push(line)
  }

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
        style={{ flexDirection: "column", width: boxWidth, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
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

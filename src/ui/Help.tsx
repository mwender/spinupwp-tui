// Help overlay: an "About Spinup" column plus the keybindings, laid out in
// responsive columns so it stays short on wide terminals and stacks on narrow
// ones. Rendered on top via zIndex. Opened/closed with `?`.

import type { ReactNode } from "react"
import { useTerminalDimensions } from "@opentui/react"
import { theme } from "../lib/theme.ts"
import { APP_NAME, APP_VERSION, REPO_URL } from "../version.ts"
import { Sparkle } from "./components.tsx"
import { useStore } from "./store.tsx"
import type { UpdateInfo } from "../lib/appUpdate.ts"

type Section = { title: string; keys: [string, string][] }

const GLOBAL: Section = {
  title: "Global",
  keys: [
    ["1 … 5", "Switch tabs"],
    ["r", "Refresh from the API"],
    ["/", "Global search"],
    ["i", "Explain the current screen"],
    ["?", "This help"],
    ["q · Ctrl+C", "Quit · force quit"],
  ],
}

const NAV: Section = {
  title: "Navigate & act",
  keys: [
    ["↑/↓  j/k", "Move selection"],
    ["Enter / →", "Drill in"],
    ["← / Esc", "Back / collapse"],
    ["Tab", "Switch column focus"],
    ["g / G", "Jump to top / bottom"],
    ["o", "Open the site's URL"],
    ["s", "SSH into the site"],
    ["h", "Server health (SSH)"],
    ["w", "Open in SpinupWP web app"],
    ["a", "Server actions (reboot/restart)"],
    ["u", "Change PHP version"],
    ["d", "Identify a site's app (SSH)"],
  ],
}

const LOCAL: Section = {
  title: "Local working copy",
  keys: [
    ["L", "Link / edit local copy"],
    ["t", "Terminal at the local copy"],
    ["v", "Open the local URL"],
    ["S", "Scan & batch-link (Stacks)"],
    ["f", "Sites needing a local copy"],
  ],
}

const DBMEDIA: Section = {
  title: "Database & media (local)",
  keys: [
    ["d", "Download prod DB backup (Search)"],
    ["p", "Pull prod DB → local (opt-in)"],
    ["m", "Production media fallback"],
  ],
}

const DNS: Section = {
  title: "DNS hosts",
  keys: [
    ["n / N", "Site / server DNS inventory"],
    ["Enter", "Edit a record's TTL"],
    ["c", "Connect provider / open console"],
    ["✓ ↗ ○ ·", "editable · web · needs key · ?"],
  ],
}

const MARKERS: Section = {
  title: "Row markers",
  keys: [
    ["◆", "Local copy linked"],
    ["↑N", "Pending WP updates"],
    ["⇣ / ⬇", "Sync / backup running"],
  ],
}

const SEARCHTAB: Section = {
  title: "Search tab",
  keys: [
    ["Tab / →", "Box → result actions"],
    ["← / Esc", "Back to the box"],
  ],
}

// Column groupings: two balanced columns on wide screens, one column otherwise.
const TWO_COLS: Section[][] = [
  [GLOBAL, NAV, SEARCHTAB],
  [LOCAL, DBMEDIA, DNS, MARKERS],
]
const ONE_COL: Section[][] = [[GLOBAL, NAV, LOCAL, DBMEDIA, DNS, MARKERS, SEARCHTAB]]

const ABOUT_W = 34
const SC_W_MIN = 34 // never narrower than this; below it, fall back to one column

function KeyRow({ k, desc }: { k: string; desc: string }) {
  return (
    <box style={{ flexDirection: "row" }}>
      <box style={{ width: 13, flexShrink: 0 }}>
        <text content={k} fg={theme.brand} wrapMode="none" />
      </box>
      <text content={desc} fg={theme.text} style={{ flexGrow: 1, flexShrink: 1 }} />
    </box>
  )
}

function SectionBlock({ section }: { section: Section }) {
  return (
    <box style={{ flexDirection: "column" }}>
      <text content={section.title} fg={theme.accent} attributes={1} />
      {section.keys.map(([k, desc]) => (
        <KeyRow key={k} k={k} desc={desc} />
      ))}
      <box style={{ height: 1 }} />
    </box>
  )
}

function ShortcutColumn({ sections, width }: { sections: Section[]; width: number }) {
  return (
    <box style={{ flexDirection: "column", width, flexShrink: 0 }}>
      {sections.map((s) => (
        <SectionBlock key={s.title} section={s} />
      ))}
    </box>
  )
}

function AboutColumn({ width, updateInfo }: { width: number; updateInfo: UpdateInfo | null }) {
  const line = (content: string, fg: string = theme.textDim): ReactNode => (
    <text content={content} fg={fg} wrapMode="none" />
  )
  return (
    <box style={{ flexDirection: "column", width, flexShrink: 0 }}>
      <box style={{ flexDirection: "row" }}>
        <text content={`◆ ${APP_NAME}`} fg={theme.brand} attributes={1} />
        <text content={`  v${APP_VERSION}`} fg={theme.text} />
      </box>
      <box style={{ height: 1 }} />
      {line("A terminal control center for")}
      {line("your SpinupWP account.")}
      <box style={{ height: 1 }} />
      <text content="UPDATING" fg={theme.accent} attributes={1} />
      {updateInfo?.updateAvailable ? (
        <box style={{ flexDirection: "row" }}>
          <Sparkle />
          <text content={`  v${updateInfo.latest} available`} fg={theme.brand} attributes={1} wrapMode="none" />
        </box>
      ) : updateInfo ? (
        line("You're on the latest.", theme.textFaint)
      ) : null}
      {line("git pull in your checkout —")}
      {line("the global spinup command")}
      {line("picks it up immediately.")}
      <box style={{ height: 1 }} />
      <box style={{ flexDirection: "row" }}>
        <text content="check  " fg={theme.textFaint} />
        <text content="spinup --version" fg={theme.text} wrapMode="none" />
      </box>
      <box style={{ height: 1 }} />
      {line(REPO_URL.replace(/^https:\/\//, ""), theme.textFaint)}
      {line("Built with OpenTUI", theme.textFaint)}
    </box>
  )
}

export function HelpOverlay({ onClose: _onClose }: { onClose: () => void }) {
  const { width } = useTerminalDimensions()
  const { updateInfo } = useStore()
  const aboutLeft = width >= 96
  const twoShortcutCols = width >= 118

  // Fill the terminal up to a cap, then size columns to the content area (box
  // width − 2 border − 4 padding). Computing widths from the real space keeps it
  // from clipping on narrow terminals and from sprawling on ultra-wide ones.
  const GAP = 3
  const boxWidth = Math.min(width - 4, 152)
  const content = boxWidth - 6

  const groups = twoShortcutCols ? TWO_COLS : ONE_COL
  const cols = groups.length
  const aboutWidth = aboutLeft ? ABOUT_W : content
  const scArea = aboutLeft ? content - ABOUT_W - GAP : content
  const scWidth = Math.max(SC_W_MIN, Math.floor((scArea - (cols - 1) * GAP) / cols))

  const shortcutCols = groups.map((sections, i) => (
    <box key={i} style={{ marginLeft: aboutLeft || i > 0 ? GAP : 0 }}>
      <ShortcutColumn sections={sections} width={scWidth} />
    </box>
  ))

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
        title={` ${APP_NAME} — Help `}
        titleColor={theme.brand}
        bottomTitle=" press ? or Esc to close "
        bottomTitleAlignment="center"
        border
        borderColor={theme.borderActive}
        backgroundColor={theme.bgPanel}
        style={{ flexDirection: "column", width: boxWidth, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
      >
        {aboutLeft ? (
          <box style={{ flexDirection: "row", alignItems: "flex-start" }}>
            <AboutColumn width={aboutWidth} updateInfo={updateInfo} />
            {shortcutCols}
          </box>
        ) : (
          <box style={{ flexDirection: "column" }}>
            <AboutColumn width={aboutWidth} updateInfo={updateInfo} />
            <box style={{ height: 1 }} />
            {shortcutCols}
          </box>
        )}
      </box>
    </box>
  )
}

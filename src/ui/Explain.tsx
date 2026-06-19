// "Explain this screen" overlay — contextual, in-context guidance (Pass 2).
//
// Distinct from the `?` keybinding reference: this is scoped to the CURRENT view
// and speaks in outcomes — what each pane is for and what each action actually
// accomplishes *here*. Opened with `i` from any view. Because it's per-route,
// every new (often novel) workflow ships with its own plain-language explanation
// rather than relying on the user to translate a flat key-list back to the screen.

import { theme } from "../lib/theme.ts"
import type { Route } from "./store.tsx"

interface Guide {
  title: string
  summary: string
  panes?: [string, string][]
  actions: [string, string][]
}

const GUIDES: Record<Route, Guide> = {
  dashboard: {
    title: "Dashboard",
    summary: "A high-level read on your whole account — fleet health, what needs attention, and recent activity.",
    panes: [
      ["Stat cards", "Totals: servers, sites, fleet disk, pending WordPress updates"],
      ["Disk usage", "Servers ranked by how full their disk is"],
      ["Needs attention", "Servers/sites with problems (offline, reboot or upgrade due)"],
      ["Recent activity", "The latest deploys and operations"],
    ],
    actions: [
      ["1–5", "Switch tabs"],
      ["r", "Refresh from the API"],
    ],
  },
  servers: {
    title: "Servers",
    summary: "Browse every server and drill into the sites it hosts.",
    panes: [
      ["Servers", "All your servers"],
      ["Sites", "Sites on the selected server"],
      ["Details", "Everything about the highlighted server or site"],
    ],
    actions: [
      ["→ / ⏎", "Drill in (server → its sites)"],
      ["h", "Server health over SSH (CPU / memory / disk)"],
      ["a", "Server actions: reboot or restart a service"],
      ["d", "Identify the app running on a site (SSH)"],
      ["u", "Change a site's PHP version"],
      ["o / w", "Open the site · open it in the SpinupWP web app"],
      ["s", "Open a terminal and SSH into the site"],
      ["t / v / L", "Local copy: open a terminal · open the local URL · link or edit"],
    ],
  },
  stacks: {
    title: "Stacks",
    summary: "Your fleet grouped by app type (Standard WP / Bedrock / Non-WP), with a fleet-wide PHP version breakdown.",
    panes: [
      ["Groups", "App-type buckets; Non-WP expands into WHMCS / Laravel / …"],
      ["Sites", "The sites in the selected group"],
      ["PHP versions", "How many sites run each PHP version (EOL flagged)"],
    ],
    actions: [
      ["d", "Identify the app on a site (SSH)"],
      ["D", "Identify every app in the selected group"],
      ["S", "Find local copies on your disk and link them"],
      ["f", "Report sites with no local copy (filter by stack with ←/→)"],
      ["u", "Change a site's PHP version"],
      ["t / v / L", "Local copy: terminal · local URL · link or edit"],
      ["o / w", "Open the site · open it in SpinupWP"],
      ["s", "Open a terminal and SSH into the site"],
    ],
  },
  search: {
    title: "Search",
    summary: "Jump to any server or site across your whole account by typing its name, domain, or IP.",
    panes: [
      ["Results", "Matches, narrowed as you type"],
      ["Details / Actions", "Info on the selection, or its action menu when focused"],
    ],
    actions: [
      ["type", "Filter results"],
      ["Tab / →", "Hand focus from the box to the result's actions"],
      ["o / w / u", "Open · open in SpinupWP · change PHP"],
      ["s", "SSH into the site (opens a terminal)"],
      ["t / v / L", "Local copy: terminal · local URL · link or edit"],
      ["a / h", "Server actions · server health"],
    ],
  },
  events: {
    title: "Events",
    summary: "A live feed of deploys, reboots, and operations across your account.",
    actions: [
      ["1–5", "Switch tabs"],
      ["r", "Refresh"],
    ],
  },
}

export function ExplainOverlay({ route }: { route: Route }) {
  const g = GUIDES[route]
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
        zIndex: 120,
      }}
    >
      <box
        title={` ${g.title} — what's on this screen `}
        titleColor={theme.brand}
        bottomTitle=" press i or Esc to close "
        bottomTitleAlignment="center"
        border
        borderColor={theme.borderActive}
        backgroundColor={theme.bgPanel}
        style={{ flexDirection: "column", width: 72, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
      >
        <text content={g.summary} fg={theme.text} />
        <box style={{ height: 1 }} />

        {g.panes && (
          <box style={{ flexDirection: "column" }}>
            <text content="On screen" fg={theme.accent} attributes={1} />
            {g.panes.map(([label, desc]) => (
              <box key={label} style={{ flexDirection: "row" }}>
                <text content={label.padEnd(16)} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
                <text content={desc} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
              </box>
            ))}
            <box style={{ height: 1 }} />
          </box>
        )}

        <text content="What you can do" fg={theme.accent} attributes={1} />
        {g.actions.map(([k, desc]) => (
          <box key={k} style={{ flexDirection: "row" }}>
            <text content={k.padEnd(11)} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
            <text content={desc} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
        ))}
        <box style={{ height: 1 }} />

        <box style={{ flexDirection: "row" }}>
          <text content="◆ " fg={theme.good} style={{ flexShrink: 0 }} />
          <text content="linked locally    " fg={theme.textDim} style={{ flexShrink: 0 }} />
          <text content="↑N " fg={theme.warn} style={{ flexShrink: 0 }} />
          <text content="pending WordPress updates" fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
        </box>
      </box>
    </box>
  )
}

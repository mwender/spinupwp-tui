// Top navigation bar: brand mark, tab strip, and live account summary.

import { theme } from "../lib/theme.ts"
import { useStore, type Route } from "./store.tsx"
import { timeAgo } from "../lib/format.ts"
import { Spinner } from "./components.tsx"

const TABS: { route: Route; key: string; label: string }[] = [
  { route: "dashboard", key: "1", label: "Dashboard" },
  { route: "servers", key: "2", label: "Servers" },
  { route: "stacks", key: "3", label: "Stacks" },
  { route: "search", key: "4", label: "Search" },
  { route: "events", key: "5", label: "Events" },
]

// A one-line "what is this view, and what can I do here" subtitle per tab —
// the cheapest in-context teaching surface. Phrased in outcomes, naming the few
// actions a user would reach for. Shown directly under the nav strip.
const SUBTITLES: Record<Route, string> = {
  dashboard: "Your account at a glance — fleet health, what needs attention, recent activity",
  servers: "Browse servers and their sites  ·  h server health  ·  u change PHP  ·  L link a local copy",
  stacks: "Your fleet grouped by app type  ·  d identify an app (SSH)  ·  S find local copies on your disk",
  search: "Jump to any server or site by name  ·  Tab hands focus to the result's actions",
  events: "Recent deploys, reboots, and operations across your account",
}

export function Header() {
  const { route, servers, sites, loading, lastUpdated } = useStore()

  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
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
        <text content="◆ SpinupWP" fg={theme.brand} style={{ flexShrink: 0 }} />
        <box style={{ width: 2, flexShrink: 0 }} />
        {TABS.map((tab) => {
          const active = tab.route === route
          return (
            <box key={tab.route} style={{ flexDirection: "row", flexShrink: 0 }}>
              <text content={` ${tab.key} `} fg={active ? theme.bg : theme.textFaint} bg={active ? theme.brand : undefined} />
              <text
                content={`${tab.label}  `}
                fg={active ? theme.text : theme.textDim}
                bg={active ? theme.bgPanel : undefined}
              />
            </box>
          )
        })}
        <box style={{ flexGrow: 1 }} />
        {loading && <Spinner interval={100} />}
        <text content={`  ${servers.length} servers · ${sites.length} sites  `} fg={theme.textDim} style={{ flexShrink: 0 }} />
        <text content={lastUpdated ? `updated ${timeAgo(lastUpdated.toISOString())}` : "loading…"} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>
      <box style={{ flexDirection: "row", height: 1, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="💡 " fg={theme.accent} style={{ flexShrink: 0 }} />
        <text content={SUBTITLES[route]} fg={theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
      </box>
    </box>
  )
}

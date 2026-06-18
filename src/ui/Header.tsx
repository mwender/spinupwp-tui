// Top navigation bar: brand mark, tab strip, and live account summary.

import { theme } from "../lib/theme.ts"
import { useStore, type Route } from "./store.tsx"
import { timeAgo } from "../lib/format.ts"
import { Spinner } from "./components.tsx"

const TABS: { route: Route; key: string; label: string }[] = [
  { route: "dashboard", key: "1", label: "Dashboard" },
  { route: "servers", key: "2", label: "Servers" },
  { route: "search", key: "3", label: "Search" },
  { route: "events", key: "4", label: "Events" },
]

export function Header() {
  const { route, servers, sites, loading, lastUpdated } = useStore()

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
  )
}

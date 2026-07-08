// Top navigation bar: brand mark, tab strip, and live account summary.

import { theme } from "../lib/theme.ts"
import { useStore, isNewServerInFlight, isVanityInFlight, isCloneInFlight, type Route } from "./store.tsx"
import { timeAgo, truncate } from "../lib/format.ts"
import { Spinner } from "./components.tsx"
import { APP_NAME, APP_VERSION } from "../version.ts"
import { isDevMode } from "../dev/devMode.ts"

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
  const { route, servers, sites, loading, lastUpdated, updateInfo, newServerJob, vanityJob, cloneJob, cloneServer, kumaStatus } = useStore()
  const kumaDown = [...kumaStatus.values()].filter((s) => s.up === false).length
  const updateReady = updateInfo?.updateAvailable ?? false
  const building = isNewServerInFlight(newServerJob)
  // The sshkey step is the one that waits on the USER (add your key, confirm in
  // the overlay) — a spinner there reads as "working" when nothing is running,
  // so it gets a distinct waiting badge that says what it wants and where.
  const vanityWaiting = vanityJob?.step === "sshkey"
  const connecting = isVanityInFlight(vanityJob) && !vanityWaiting
  const vanityStuck = vanityJob != null && vanityJob.step === "error"
  // Show a clone badge only when it's running AND backgrounded (wizard closed) — the
  // open wizard covers the screen, so no badge is needed there.
  const cloning = isCloneInFlight(cloneJob) && cloneServer == null

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
        <text content={`◆ ${APP_NAME}`} fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={` v${APP_VERSION}`} fg={theme.textFaint} style={{ flexShrink: 0 }} />
        {updateReady && <text content={` ✦ v${updateInfo!.latest}`} fg={theme.update} attributes={1} style={{ flexShrink: 0 }} />}
        {isDevMode() && <text content=" DEV MODE " fg={theme.bg} bg={theme.purple} attributes={1} style={{ flexShrink: 0 }} />}
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
        {/* A server provision runs for ~10 min in the background; surface it from
            any tab so it isn't invisible once the New Server overlay is closed
            (press c on the Servers tab to reopen the live tracker). */}
        {building && (
          <box style={{ flexDirection: "row", flexShrink: 0, alignItems: "center" }}>
            <Spinner interval={120} color={theme.warn} />
            <text content={`  Provisioning ${truncate(newServerJob!.hostname, 22)}  `} fg={theme.warn} wrapMode="none" />
          </box>
        )}
        {/* Vanity build runs in the background too — surface it so it's reachable
            after the site is created (press V on its server to reopen). A stuck
            (errored) build is flagged too so it isn't lost. */}
        {connecting && (
          <box style={{ flexDirection: "row", flexShrink: 0, alignItems: "center" }}>
            <Spinner interval={120} color={theme.warn} />
            <text content={`  Connecting ${truncate(vanityJob!.hostname, 22)} — press V  `} fg={theme.warn} wrapMode="none" />
          </box>
        )}
        {vanityWaiting && (
          <text content={`  ○ ${truncate(vanityJob!.hostname, 20)} needs your SSH key — press V  `} fg={theme.warn} style={{ flexShrink: 0 }} wrapMode="none" />
        )}
        {vanityStuck && <text content={`  ⚠ ${truncate(vanityJob!.hostname, 20)} — press V  `} fg={theme.bad} style={{ flexShrink: 0 }} wrapMode="none" />}
        {/* A backgrounded clone keeps running in the store — surface it so it's
            reachable (press C on the source server to reopen the live roster). */}
        {cloning && (
          <box style={{ flexDirection: "row", flexShrink: 0, alignItems: "center" }}>
            <Spinner interval={120} color={theme.warn} />
            <text content={`  Cloning ${truncate(cloneJob!.sourceServerName, 20)} — press C  `} fg={theme.warn} wrapMode="none" />
          </box>
        )}
        {/* Uptime Kuma: only bad news earns header space — silence when all up. */}
        {kumaDown > 0 && <text content={`  ▼ ${kumaDown} monitor${kumaDown === 1 ? "" : "s"} down  `} fg={theme.bad} style={{ flexShrink: 0 }} wrapMode="none" />}
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

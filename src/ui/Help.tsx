// Modal-style help overlay listing all keybindings. Rendered on top via zIndex.

import { theme } from "../lib/theme.ts"

const SECTIONS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Global",
    keys: [
      ["1 … 5", "Switch tabs: Dashboard · Servers · Stacks · Search · Events"],
      ["r", "Refresh data from the API"],
      ["/", "Jump to global search"],
      ["?", "Toggle this help"],
      ["q", "Quit"],
      ["Ctrl+C", "Force quit"],
    ],
  },
  {
    title: "Lists & Panels",
    keys: [
      ["↑ / ↓  or  j / k", "Move selection"],
      ["Enter / →", "Drill in (server → its sites, site → details)"],
      ["← / Esc", "Go back / collapse"],
      ["Tab", "Switch focus between columns"],
      ["o", "Open the selected site's URL in your browser"],
      ["h", "Live server health (CPU/mem/disk over SSH)"],
      ["d", "Detect a site's stack via SSH (Servers / Stacks tabs)"],
      ["D", "Detect every site in the selected stack (Stacks tab)"],
      ["u", "Upgrade a site's PHP version (needs a Read/Write token)"],
      ["a", "Server actions: reboot or restart a service (Read/Write token)"],
      ["w", "Open the selected server/site in the SpinupWP web app"],
      ["g / G", "Jump to top / bottom"],
    ],
  },
  {
    title: "Search tab",
    keys: [
      ["Tab / →", "Hand focus from the search box to the result's actions"],
      ["o / w / u / a / h", "Act: open · SpinupWP · PHP · server actions · health"],
      ["← / Esc", "Return to the search box"],
    ],
  },
]

export function HelpOverlay({ onClose }: { onClose: () => void }) {
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
        title=" Keyboard Shortcuts "
        titleColor={theme.brand}
        bottomTitle=" press ? or Esc to close "
        bottomTitleAlignment="center"
        border
        borderColor={theme.borderActive}
        backgroundColor={theme.bgPanel}
        style={{ flexDirection: "column", width: 64, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
      >
        {SECTIONS.map((section) => (
          <box key={section.title} style={{ flexDirection: "column" }}>
            <text content={section.title} fg={theme.accent} attributes={1} />
            {section.keys.map(([k, desc]) => (
              <box key={k} style={{ flexDirection: "row" }}>
                <text content={k.padEnd(18)} fg={theme.brand} />
                <text content={desc} fg={theme.text} />
              </box>
            ))}
            <box style={{ height: 1 }} />
          </box>
        ))}
        <text content="A SpinupWP control center · built with OpenTUI" fg={theme.textFaint} />
      </box>
    </box>
  )
}

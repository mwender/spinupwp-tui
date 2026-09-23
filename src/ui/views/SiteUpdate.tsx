// `u` → Update: one entry point for everything you can update on a site.
//
// A small menu that hands off to the per-thing flows — PHP version (SpinupWP
// API, PhpUpgrade.tsx) and WordPress core (wp-cli over SSH, WpCoreUpdate.tsx).
// Each flow owns its own keyboard while shown; ← from its first screen comes
// back here. Opened via the store's phpUpgradeSite (the overlay's historical
// name — it's the "site being updated" now).

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { effectiveStack } from "../../lib/stack.ts"
import { Panel, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { moveSelection } from "../List.tsx"
import { PhpUpgrade } from "./PhpUpgrade.tsx"
import { WpCoreUpdate } from "./WpCoreUpdate.tsx"

type Section = "menu" | "php" | "wp"

export function SiteUpdate() {
  const { phpUpgradeSite: site, setPhpUpgradeSite, probes, isPhpEol, phpUpgrades } = useStore()
  const [section, setSection] = useState<Section>("menu")
  const [index, setIndex] = useState(0)

  const stack = site ? effectiveStack(site, probes.get(site.id)?.result.kind) : "Non-WP"
  const php = site?.php_version ? site.php_version.split(".").slice(0, 2).join(".") : "—"
  const phpBusy = site ? phpUpgrades.get(site.id) : undefined

  const items: { key: Section; label: string; detail: string; detailFg: string }[] = [
    {
      key: "php",
      label: "PHP version",
      detail: phpBusy && phpBusy.status !== "failed" ? `→ ${phpBusy.target} in progress` : `PHP ${php}${isPhpEol(php) ? " (EOL)" : ""}`,
      detailFg: isPhpEol(php) ? theme.bad : theme.textFaint,
    },
    {
      key: "wp",
      label: "WordPress core",
      // SpinupWP's own flag is a periodic snapshot; the SSH check is authoritative.
      detail:
        stack === "Non-WP" ? "not detected as WordPress" : site?.wp_core_update ? "update available (per SpinupWP)" : stack === "Standard WP" ? "via wp-cli" : `via wp-cli · ${stack}`,
      detailFg: site?.wp_core_update ? theme.warn : theme.textFaint,
    },
  ]

  const close = () => setPhpUpgradeSite(null)

  useKeyboard((key) => {
    if (section !== "menu") return
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()
    switch (name) {
      case "up":
      case "k":
        return setIndex((i) => moveSelection(i, -1, items.length))
      case "down":
      case "j":
        return setIndex((i) => moveSelection(i, 1, items.length))
      case "p":
        return setSection("php")
      case "w":
        return setSection("wp")
      case "return":
      case "right":
      case "l":
        return setSection(items[index].key)
    }
  })

  if (!site) return null
  if (section === "php") return <PhpUpgrade onBack={() => setSection("menu")} />
  if (section === "wp") return <WpCoreUpdate site={site} onBack={() => setSection("menu")} onClose={close} />

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.bg,
        zIndex: 210,
      }}
    >
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="⬆ Update  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={stack} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>
        <Panel title=" What do you want to update? " active>
          <box style={{ flexDirection: "column", width: 60 }}>
            {items.map((it, i) => {
              const selected = i === index
              return (
                <box key={it.key} style={{ flexDirection: "row", height: 1, backgroundColor: selected ? theme.selectedBg : undefined }}>
                  <text content={(selected ? "❯ " : "  ") + it.label} fg={selected ? theme.text : theme.textDim} style={{ flexGrow: 1 }} wrapMode="none" />
                  <text content={it.detail} fg={selected ? theme.text : it.detailFg} style={{ flexShrink: 0 }} wrapMode="none" />
                </box>
              )
            })}
          </box>
        </Panel>
      </Centered>

      <StatusBar
        hints={[
          { key: "↑↓/jk", label: "choose" },
          { key: "⏎", label: "open" },
          { key: "p/w", label: "PHP / WordPress" },
          { key: "esc", label: "close" },
        ]}
        showGlobal={false}
      />
    </box>
  )
}

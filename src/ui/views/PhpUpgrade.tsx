// PHP-version upgrade overlay — the app's first *write* action.
//
// Opened with `u` on a selected site (Browser / Stacks). Walks through: pick a
// version → confirm → fire the upgrade. The actual PUT + event polling live in
// the store (`startPhpUpgrade`), so closing this modal (Esc/q) doesn't abandon
// the upgrade — the site's row keeps a spinner until it settles. A site whose
// server has a pending SpinupWP platform upgrade is blocked up front (the API
// can't manage it until that runs — point the user at the `w` deep link).

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { moveSelection } from "../List.tsx"

type Phase = "blocked" | "pick" | "confirm" | "tracking" | "done" | "error"

function majorMinor(v: string | null | undefined): string {
  if (!v) return "—"
  const [maj, min] = v.split(".")
  return min != null ? `${maj}.${min}` : maj
}

export function PhpUpgrade() {
  const store = useStore()
  const {
    phpUpgradeSite: site,
    setPhpUpgradeSite,
    serverById,
    offeredPhpVersions,
    isPhpEol,
    accountSlug,
    phpUpgrades,
    startPhpUpgrade,
    clearPhpUpgrade,
  } = store

  const server = serverById(site?.server_id)
  const versions = site ? offeredPhpVersions(site.php_version) : []
  const current = majorMinor(site?.php_version)

  // Start blocked if the server can't be managed via the API yet.
  const [phase, setPhase] = useState<Phase>(() => (server?.upgrade_required ? "blocked" : "pick"))
  // Open the cursor on the current version (orients the user) when present.
  const [index, setIndex] = useState(() => {
    const i = versions.indexOf(current)
    return i >= 0 ? i : 0
  })
  const [target, setTarget] = useState<string | null>(null)

  // Background progress for this site, owned by the store. Once we've fired the
  // upgrade ("tracking"), the screen follows the store's event status: a settled
  // failure shows the error; a cleared entry (deleted on deploy) means success.
  const progress = site ? phpUpgrades.get(site.id) : undefined
  const dp: Phase =
    phase !== "tracking"
      ? phase
      : !progress
        ? "done"
        : progress.status === "failed"
          ? "error"
          : "tracking"

  const close = () => {
    // Leave an in-flight upgrade running (its row keeps the spinner); only drop a
    // settled failure so its marker doesn't linger after the user has seen it.
    if (site && progress?.status === "failed") clearPhpUpgrade(site.id)
    setPhpUpgradeSite(null)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    // Esc/q always closes — the upgrade keeps running in the background.
    if (name === "escape" || name === "q") return close()

    if (dp === "pick") {
      switch (name) {
        case "up":
        case "k":
          return setIndex((i) => moveSelection(i, -1, versions.length))
        case "down":
        case "j":
          return setIndex((i) => moveSelection(i, 1, versions.length))
        case "return":
        case "right":
        case "l": {
          const v = versions[index]
          if (!v || v === current) return // no-op on the current version
          setTarget(v)
          setPhase("confirm")
          return
        }
      }
      return
    }

    if (dp === "confirm") {
      if (name === "y") {
        if (site && target) {
          startPhpUpgrade(site, target)
          setPhase("tracking")
        }
        return
      }
      if (name === "left" || name === "h") return setPhase("pick")
      return
    }

    if (dp === "error") {
      if (name === "r") {
        if (site) clearPhpUpgrade(site.id)
        setPhase("pick")
      }
      return
    }
  })

  if (!site) return null

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
      {/* Title bar */}
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
        <text content="⬆ Upgrade PHP  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={`current PHP ${current}`} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "blocked") {
      return (
        <Panel title=" Can't upgrade yet " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <text content="This site's server has a pending SpinupWP platform upgrade." fg={theme.warn} wrapMode="none" />
            <text content="SpinupWP can't manage the site over the API until that runs." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text
              content={
                accountSlug
                  ? "Press w in the Servers view to open the server in SpinupWP."
                  : "Open the server in SpinupWP to run the upgrade (set accountSlug for a deep link)."
              }
              fg={theme.textDim}
              wrapMode="none"
            />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    if (dp === "pick") {
      return (
        <Panel title=" Choose a PHP version " active>
          <box style={{ flexDirection: "column", width: 48 }}>
            {versions.map((v, i) => {
              const selected = i === index
              const isCurrent = v === current
              const eol = isPhpEol(v)
              // On the highlighted row, force bright text so it stays legible on
              // the green selection background (same approach as List/Stacks).
              const baseFg = isCurrent ? theme.textFaint : eol ? theme.bad : theme.textDim
              const fg = selected ? theme.text : baseFg
              const tag = isCurrent ? "  (current)" : eol ? "  (EOL)" : ""
              const tagFg = selected ? theme.text : isCurrent ? theme.textFaint : theme.bad
              return (
                <box
                  key={v}
                  style={{ flexDirection: "row", height: 1, backgroundColor: selected ? theme.selectedBg : undefined }}
                >
                  <text content={(selected ? "❯ " : "  ") + `PHP ${v}`} fg={fg} style={{ flexGrow: 1 }} wrapMode="none" />
                  <text content={tag} fg={tagFg} style={{ flexShrink: 0 }} />
                </box>
              )
            })}
            <box style={{ height: 1 }} />
            <text content="A version not on the server is installed first." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "confirm") {
      return (
        <Panel title=" Confirm upgrade " active>
          <box style={{ flexDirection: "column", width: 60, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="Upgrade " fg={theme.text} />
              <text content={truncate(site!.domain, 32)} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ flexDirection: "row" }}>
              <text content={`from PHP ${current}`} fg={theme.textDim} />
              <text content="  →  " fg={theme.textFaint} />
              <text content={`PHP ${target}`} fg={theme.good} />
            </box>
            <box style={{ height: 1 }} />
            <text content="SpinupWP restarts PHP-FPM (and installs the version first" fg={theme.textDim} wrapMode="none" />
            <text content="if it isn't present on the server yet)." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press y to confirm · ← to go back · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "tracking") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={`  Upgrading to PHP ${target} — ${progress?.status ?? "queued"}…`} fg={theme.textDim} />
          </box>
          <box style={{ height: 1 }} />
          <text content="You can press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }

    if (dp === "done") {
      return (
        <Panel title=" Done " active>
          <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ " fg={theme.good} />
              <text content={truncate(site!.domain, 32)} fg={theme.accent} wrapMode="none" />
              <text content={` is now on PHP ${target}`} fg={theme.text} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    // error
    return (
      <Panel title=" Upgrade failed " active>
        <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${progress?.error ?? "Something went wrong."}`} fg={theme.bad} />
          <box style={{ height: 1 }} />
          <text content="Press r to choose another version · Esc to close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "pick":
        return [
          { key: "↑↓/jk", label: "version" },
          { key: "⏎", label: "choose" },
          { key: "esc", label: "cancel" },
        ]
      case "confirm":
        return [
          { key: "y", label: "confirm" },
          { key: "←", label: "back" },
          { key: "esc", label: "cancel" },
        ]
      case "error":
        return [
          { key: "r", label: "retry" },
          { key: "esc", label: "close" },
        ]
      default:
        return [{ key: "esc", label: "close" }]
    }
  }
}

// Server actions overlay — reboot the server or restart a single service.
//
// Opened with `a` on a selected server (Servers tab / Search). Like the PHP
// upgrade overlay: pick an action → confirm → POST → poll the event. The actual
// call + polling live in the store (`startServerOp`), so closing the overlay
// (Esc) leaves it running and the server's row keeps a spinner. When a reboot is
// pending, we SSH-probe the *why* (Ubuntu's pending-restart packages) and show
// it — labeled as OS context, not as SpinupWP's internal logic.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { moveSelection } from "../List.tsx"
import type { RebootInfo } from "../../lib/ssh.ts"
import { MAX_SWAP_GIB, MIN_SWAP_GIB, type SwapStatus, validateSwapSizeGiB } from "../../lib/swap.ts"
import type { ServerOpKind } from "../store.tsx"

function formatSwapGiB(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)} GiB`
}

function isResizableSwap(status: SwapStatus | undefined): boolean {
  return status?.kind === "active" && status.entries.length === 1 && status.entries[0].name === "/swapfile"
}

type Phase = "pick" | "swap" | "confirm" | "tracking" | "done" | "error"
type ActionKind = ServerOpKind | "swap"

interface Action {
  kind: ActionKind
  label: string // menu label, e.g. "Restart Nginx"
  verb: string // short progress verb, e.g. "nginx"
}

const ACTIONS: Action[] = [
  { kind: "reboot", label: "Reboot server", verb: "rebooting" },
  { kind: "nginx", label: "Restart Nginx", verb: "nginx" },
  { kind: "php", label: "Restart PHP-FPM", verb: "php-fpm" },
  { kind: "mysql", label: "Restart MySQL", verb: "mysql" },
  { kind: "redis", label: "Restart Redis", verb: "redis" },
  { kind: "swap", label: "Manage swap memory", verb: "swap" },
]

// Short headline for the menu / detail; the full package list is shown on the
// (wider) confirm screen, one per line.
function rebootSummary(info: RebootInfo): string {
  if (!info.present) return "no restart currently flagged on the server"
  const head = info.kernel ? "kernel update" : "package updates"
  const n = info.packages.length
  return `${head} · ${n} package${n === 1 ? "" : "s"}`
}

export function ServerActions() {
  const store = useStore()
  const {
    serverActionsServer: server,
    setServerActionsServer,
    sitesForServer,
    serverOps,
    startServerOp,
    clearServerOp,
    rebootInfo,
    rebootInfoLoading,
    rebootInfoErrors,
    loadRebootInfo,
    swapStatus,
    swapStatusLoading,
    swapStatusErrors,
    loadSwapStatus,
    swapProgress,
    startSwapEnsure,
    clearSwapProgress,
    isSudoConnected,
    sudoUserFor,
  } = store

  const rebootRequired = !!server?.reboot_required
  const [phase, setPhase] = useState<Phase>("pick")
  // Cursor starts on Reboot when one is pending, else on the first restart.
  const [index, setIndex] = useState(() => (server?.reboot_required ? 0 : 1))
  const [target, setTarget] = useState<Action | null>(null)
  const [swapSizeInput, setSwapSizeInput] = useState("")
  const [swapSizeError, setSwapSizeError] = useState<string | null>(null)

  const siteCount = server ? sitesForServer(server.id).length : 0
  const info = server ? rebootInfo.get(server.id) : undefined
  const infoLoading = server ? rebootInfoLoading.has(server.id) : false
  const infoError = server ? rebootInfoErrors.get(server.id) : undefined
  const swap = server ? swapStatus.get(server.id) : undefined
  const swapLoading = server ? swapStatusLoading.has(server.id) : false
  const swapError = server ? swapStatusErrors.get(server.id) : undefined
  const sudoConnectedForServer = server ? isSudoConnected(server.id) : false
  const sudoUser = server ? sudoUserFor(server.id) : undefined

  // Fetch the "why" once when opened on a reboot-required server.
  useEffect(() => {
    if (server && rebootRequired && !info && !infoLoading && !infoError) loadRebootInfo(server)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id])

  useEffect(() => {
    if (server && sudoConnectedForServer && !swapLoading && (!swap || !!swapError)) loadSwapStatus(server, sudoUser)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id, sudoConnectedForServer])

  const progress = server ? serverOps.get(server.id) : undefined
  const swapOp = server ? swapProgress.get(server.id) : undefined
  const activeProgress = target?.kind === "swap" ? swapOp : progress
  const dp: Phase =
    phase !== "tracking"
      ? phase
      : !activeProgress || activeProgress.status === "deployed"
        ? "done"
        : activeProgress.status === "failed"
          ? "error"
          : "tracking"

  const close = () => {
    if (server && progress?.status === "failed") clearServerOp(server.id)
    if (server && swapOp?.status === "failed") clearSwapProgress(server.id)
    setServerActionsServer(null)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()

    if (dp === "pick") {
      switch (name) {
        case "up":
        case "k":
          return setIndex((i) => moveSelection(i, -1, ACTIONS.length))
        case "down":
        case "j":
          return setIndex((i) => moveSelection(i, 1, ACTIONS.length))
        case "return":
        case "right":
        case "l":
          {
            const chosen = ACTIONS[index]
            setTarget(chosen)
            if (chosen.kind === "swap") {
              const current = isResizableSwap(swap) ? Math.round(swap!.entries[0].sizeBytes / (1024 ** 3)) : null
              const suggested = current || swap?.recommendedGiB || 2
              setSwapSizeInput(String(suggested))
              setSwapSizeError(null)
              setPhase("swap")
            } else {
              setPhase("confirm")
            }
          }
          return
      }
      return
    }

    if (dp === "swap") {
      if (swapLoading) return
      if (swapError) {
        if (name === "r") loadSwapStatus(server!, sudoUser)
        return
      }
      if (swap?.kind === "active" && !isResizableSwap(swap)) return
      if (name === "backspace" || name === "delete") {
        setSwapSizeInput((v) => v.slice(0, -1))
        setSwapSizeError(null)
        return
      }
      if (/^[0-9]$/.test(name)) {
        setSwapSizeInput((v) => (v === "0" ? name : `${v}${name}`))
        setSwapSizeError(null)
        return
      }
      if (name === "return" || name === "right" || name === "l") {
        const parsed = Number(swapSizeInput)
        if (validateSwapSizeGiB(parsed) == null) {
          setSwapSizeError(`Enter a whole number from ${MIN_SWAP_GIB} to ${MAX_SWAP_GIB} GiB.`)
          return
        }
        if (!isSudoConnected(server!.id)) {
          setSwapSizeError("Connect sudo on this server first (press S).")
          return
        }
        setPhase("confirm")
      }
      return
    }

    if (dp === "confirm") {
      if (name === "y") {
        if (server && target) {
          if (target.kind === "swap") startSwapEnsure(server, Number(swapSizeInput))
          else startServerOp(server, target.kind, target.verb)
          setPhase("tracking")
        }
        return
      }
      if (name === "left" || name === "h") return setPhase("pick")
      return
    }

    if (dp === "error") {
      if (name === "r") {
        if (server) {
          if (target?.kind === "swap") clearSwapProgress(server.id)
          else clearServerOp(server.id)
        }
        setPhase("pick")
      }
      return
    }
  })

  if (!server) return null

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
        <text content="⚙ Server actions  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(server.name, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={`${siteCount} site${siteCount === 1 ? "" : "s"}`} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "pick") {
      return (
        <Panel title=" Choose an action " active>
          <box style={{ flexDirection: "column", width: 52 }}>
            {/* Reboot "why" context */}
            {rebootRequired && (
              <>
                <box style={{ flexDirection: "row", height: 1 }}>
                  <text content="⚠ reboot pending — " fg={theme.warn} style={{ flexShrink: 0 }} />
                  {infoLoading ? (
                    <box style={{ flexDirection: "row" }}>
                      <Spinner interval={120} />
                      <text content=" checking what's pending…" fg={theme.textDim} wrapMode="none" />
                    </box>
                  ) : info ? (
                    <text content={rebootSummary(info)} fg={theme.textDim} wrapMode="none" style={{ flexShrink: 1 }} />
                  ) : infoError ? (
                    <text content="couldn't read detail over SSH" fg={theme.textFaint} wrapMode="none" />
                  ) : (
                    <text content="reboot required" fg={theme.textDim} wrapMode="none" />
                  )}
                </box>
                <box style={{ height: 1 }} />
              </>
            )}
            {ACTIONS.map((a, i) => {
              const selected = i === index
              const recommended = a.kind === "reboot" && rebootRequired
              const fg = selected ? theme.text : recommended ? theme.warn : theme.textDim
              const icon = a.kind === "reboot" ? "↻ " : a.kind === "swap" ? "⇄ " : "⟳ "
              return (
                <box
                  key={a.kind}
                  style={{ flexDirection: "row", height: 1, backgroundColor: selected ? theme.selectedBg : undefined }}
                >
                  <text content={(selected ? "❯ " : "  ") + icon + a.label} fg={fg} style={{ flexGrow: 1 }} wrapMode="none" />
                  {recommended && <text content="(recommended)" fg={selected ? theme.text : theme.warn} style={{ flexShrink: 0 }} />}
                </box>
              )
            })}
          </box>
              </Panel>
      )
    }

    if (dp === "swap") {
      return (
        <Panel title=" Manage swap memory " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            {swapLoading ? (
              <box style={{ flexDirection: "row" }}><Spinner /><text content="  Inspecting swap…" fg={theme.textDim} /></box>
            ) : swapError ? (
              <>
                <text content={`✕ ${swapError}`} fg={theme.bad} wrapMode="none" />
                <text content="Press r to retry · Esc to close" fg={theme.textFaint} wrapMode="none" />
              </>
            ) : swap?.kind === "active" && !isResizableSwap(swap) ? (
              <>
                <text content="Active swap is not a single /swapfile." fg={theme.warn} wrapMode="none" />
                <text content={`  ${swap.entries.map((e) => `${e.name} · ${formatSwapGiB(e.sizeBytes)}`).join("  ")}`} fg={theme.textDim} wrapMode="none" />
                <box style={{ height: 1 }} />
                <text content="Resize is only supported for /swapfile; no change will be made." fg={theme.textFaint} wrapMode="none" />
              </>
            ) : (
              <>
                <text content={swap?.kind === "active" ? `Active /swapfile: ${formatSwapGiB(swap.entries[0].sizeBytes)}.` : swap?.kind === "configured-inactive" ? "A configured /swapfile exists but is inactive." : "No active swap was found."} fg={theme.text} wrapMode="none" />
                <box style={{ height: 1 }} />
                <box style={{ flexDirection: "row", height: 1 }}>
                  <text content="Size (GiB): " fg={theme.textDim} />
                  <text content={swapSizeInput || "_"} fg={theme.accent} />
                  <text content={`  recommended ${swap?.recommendedGiB ?? 2}`} fg={theme.textFaint} />
                </box>
                {swapSizeError && <text content={`✕ ${swapSizeError}`} fg={theme.bad} wrapMode="none" />}
                <box style={{ height: 1 }} />
                <text content={sudoConnectedForServer ? "Press Enter to review the change." : "Connect sudo first with S, then return here; status will be checked after authentication."} fg={sudoConnectedForServer ? theme.textDim : theme.warn} wrapMode="none" />
                <text content="Type digits · Backspace edits · Esc cancels" fg={theme.textFaint} wrapMode="none" />
              </>
            )}
          </box>
        </Panel>
      )
    }

    if (dp === "confirm") {
      const isReboot = target?.kind === "reboot"
      const isSwap = target?.kind === "swap"
      const resizingSwap = isSwap && isResizableSwap(swap)
      return (
        <Panel title=" Confirm " active>
          <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content={isReboot ? "Reboot " : isSwap ? (resizingSwap ? "Resize swap on " : "Enable swap on ") : `${target?.label} on `} fg={theme.text} wrapMode="none" />
              <text content={truncate(server!.name, 30)} fg={theme.accent} wrapMode="none" />
              <text content="?" fg={theme.text} />
            </box>
            <box style={{ height: 1 }} />
            {isReboot ? (
              <>
                <text
                  content={`Reboots the whole server — downtime for all ${siteCount} site${siteCount === 1 ? "" : "s"}.`}
                  fg={theme.warn}
                  wrapMode="none"
                />
                {info?.present && (
                  <>
                    <box style={{ height: 1 }} />
                    <text content={`Pending: ${rebootSummary(info)}`} fg={theme.textDim} wrapMode="none" />
                    {info.packages.slice(0, 6).map((p) => (
                      <text key={p} content={`  • ${p}`} fg={theme.textFaint} wrapMode="none" />
                    ))}
                    {info.packages.length > 6 && (
                      <text content={`  • …${info.packages.length - 6} more`} fg={theme.textFaint} wrapMode="none" />
                    )}
                  </>
                )}
                {store.kumaConfigured && (
                  <text content="Uptime Kuma monitors enter a maintenance window — no false alerts." fg={theme.textFaint} wrapMode="none" />
                )}
              </>
            ) : isSwap ? (
              <>
                <text content={resizingSwap ? `Rebuilds /swapfile from ${formatSwapGiB(swap!.entries[0].sizeBytes)} to ${swapSizeInput} GiB.` : `Creates or enables /swapfile at ${swapSizeInput} GiB.`} fg={theme.warn} wrapMode="none" />
                {resizingSwap && <text content="Swap is briefly disabled while the replacement file is prepared." fg={theme.warn} wrapMode="none" />}
                <text content="Swap is enabled immediately and persisted in /etc/fstab." fg={theme.textDim} wrapMode="none" />
                <text content={resizingSwap ? "Only this active /swapfile will be changed." : "Existing active swap will not be changed or duplicated."} fg={theme.textFaint} wrapMode="none" />
              </>
            ) : (
              <text content="Brief interruption to that one service; sites stay up otherwise." fg={theme.textDim} wrapMode="none" />
            )}
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
            <text content={`  ${target?.label ?? "Working"} — ${activeProgress?.status ?? "queued"}…`} fg={theme.textDim} />
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
              <text content={`${target?.label ?? "Action"} completed on ` } fg={theme.text} wrapMode="none" />
              <text content={truncate(server!.name, 24)} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    // error
    return (
      <Panel title=" Action failed " active>
        <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`✕ ${activeProgress?.error ?? "Something went wrong."}`} fg={theme.bad} />
          <box style={{ height: 1 }} />
          <text content="Press r to choose another action · Esc to close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "pick":
        return [
          { key: "↑↓/jk", label: "action" },
          { key: "⏎", label: "choose" },
          { key: "esc", label: "cancel" },
        ]
      case "confirm":
        return [
          { key: "y", label: "confirm" },
          { key: "←", label: "back" },
          { key: "esc", label: "cancel" },
        ]
      case "swap":
        return [
          { key: "digits", label: "size" },
          { key: "⏎", label: "review" },
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

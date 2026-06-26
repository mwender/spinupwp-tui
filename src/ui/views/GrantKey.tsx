// Grant SSH key overlay — a privileged write-over-SSH on a sudo-connected server.
//
// Opened with `K` on a selected site (Browser). Pick which key(s) to deploy — your
// PERSONAL key(s) (so you can SSH/SFTP as yourself) and/or Spinup's dedicated
// `spinup-tui` MACHINE key (for unattended automation) — choose the scope (just
// this site, or every site on the server), confirm, and grant via the server's
// SUDO session. Requires sudo to be connected first (press `S` on the server). The
// grant runs in the store (`startGrantKey`), so closing the modal doesn't abandon it.
// See docs/2026-06-26_sudo-ssh-key-provisioning-spec.md.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, isKeyGrantInFlight } from "../store.tsx"
import { ensureSpinupKey, listPersonalKeys, buildGrantScript, keyBody, type GrantableKey } from "../../lib/ssh.ts"
import { moveSelection } from "../List.tsx"
import type { Site } from "../../api/types.ts"

type Phase = "disconnected" | "loading" | "pick" | "scope" | "confirm" | "running" | "done" | "error"

export function GrantKey() {
  const store = useStore()
  const {
    grantKeySite: site,
    setGrantKeySite,
    serverById,
    sitesForServer,
    keyGrants,
    startGrantKey,
    clearGrantKey,
    preferredGrantKeys,
    setPreferredGrantKeys,
    isSudoConnected,
    sudoUserFor,
    setSudoConnectServer,
  } = store

  const server = serverById(site?.server_id)
  const connected = server ? isSudoConnected(server.id) : false
  const sudoUser = server ? sudoUserFor(server.id) : undefined

  // Sites on this server that can receive a key (have a site_user). The anchor
  // site is always a valid single target.
  const serverSites = server ? sitesForServer(server.id).filter((s) => s.site_user) : []
  const canScope = serverSites.length > 1

  const [phase, setPhase] = useState<Phase>(() => {
    if (site && keyGrants.has(site.id)) return "running"
    return connected ? "loading" : "disconnected"
  })
  const [keys, setKeys] = useState<GrantableKey[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [index, setIndex] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scope, setScope] = useState<"site" | "server">("site")
  const [scopeIndex, setScopeIndex] = useState(0)

  // Resolve the grantable keys once (machine key + discovered personal keys).
  useEffect(() => {
    if (phase !== "loading") return
    let cancelled = false
    void Promise.all([ensureSpinupKey(), listPersonalKeys()])
      .then(([machine, personal]) => {
        if (cancelled) return
        const machineKey: GrantableKey = { id: keyBody(machine.pub), kind: "machine", label: machine.comment, line: machine.pub, source: "spinup" }
        const list = [...personal.filter((p) => p.id !== machineKey.id), machineKey]
        setKeys(list)
        const remembered = list.filter((k) => preferredGrantKeys.includes(k.id)).map((k) => k.id)
        setSelected(new Set(remembered.length > 0 ? remembered : [personal[0]?.id ?? machineKey.id]))
        setPhase("pick")
      })
      .catch((err) => {
        if (!cancelled) {
          setKeys([])
          setLoadError((err as Error).message)
          setPhase("error")
        }
      })
    return () => {
      cancelled = true
    }
  }, [phase])

  const selectedKeys = keys.filter((k) => selected.has(k.id))
  const targetSites: Site[] = scope === "server" ? serverSites : site ? [site] : []

  // Batch progress over the target sites.
  const targetProgress = targetSites.map((s) => keyGrants.get(s.id))
  const doneCount = targetProgress.filter((p) => p?.status === "done").length
  const failedSites = targetSites.filter((s) => keyGrants.get(s.id)?.status === "error")
  const settledCount = doneCount + failedSites.length
  const allSettled = targetSites.length > 0 && settledCount === targetSites.length

  const dp: Phase = phase !== "running" ? phase : allSettled ? "done" : "running"

  const close = () => {
    // Drop settled markers for the targets so they don't linger after close.
    if (phase === "running" && allSettled) for (const s of targetSites) clearGrantKey(s.id)
    setGrantKeySite(null)
  }

  const fire = (sites: Site[]) => {
    if (sites.length > 0 && selectedKeys.length > 0) {
      startGrantKey(sites, selectedKeys.map((k) => k.line))
      setPreferredGrantKeys(selectedKeys.map((k) => k.id)) // remember the choice
    }
    setPhase("running")
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()

    if (dp === "disconnected") {
      if (name === "s" && server) {
        setGrantKeySite(null)
        setSudoConnectServer(server)
      }
      return
    }

    if (dp === "pick") {
      switch (name) {
        case "up":
        case "k":
          return setIndex((i) => moveSelection(i, -1, keys.length))
        case "down":
        case "j":
          return setIndex((i) => moveSelection(i, 1, keys.length))
        case "space": {
          const k = keys[index]
          if (!k) return
          return setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(k.id)) next.delete(k.id)
            else next.add(k.id)
            return next
          })
        }
        case "return":
        case "right":
        case "l":
          if (selectedKeys.length === 0) return
          return setPhase(canScope ? "scope" : "confirm")
      }
      return
    }

    if (dp === "scope") {
      switch (name) {
        case "up":
        case "k":
          setScopeIndex(0)
          return setScope("site")
        case "down":
        case "j":
          setScopeIndex(1)
          return setScope("server")
        case "return":
        case "right":
        case "l":
          return setPhase("confirm")
        case "left":
        case "h":
          return setPhase("pick")
      }
      return
    }

    if (dp === "confirm") {
      if (name === "y") return fire(targetSites)
      if (name === "left" || name === "h") return setPhase(canScope ? "scope" : "pick")
      return
    }

    if (dp === "done") {
      if (name === "r" && failedSites.length > 0) return fire(failedSites)
      return
    }

    if (dp === "error") {
      if (name === "r") {
        setLoadError(null)
        return setPhase("loading")
      }
      return
    }
  })

  if (!site) return null

  const siteUser = site.site_user ?? "(no site user)"

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
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="🔑 Grant SSH key  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={connected ? "● " : "○ "} fg={connected ? theme.good : theme.textFaint} style={{ flexShrink: 0 }} />
        <text content={server?.name ?? "—"} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "disconnected") {
      return (
        <Panel title=" Sudo not connected " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="○ Sudo isn't connected on " fg={theme.warn} wrapMode="none" />
              <text content={server?.name ?? "this server"} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Why: each site runs as its own Linux user, and its SSH" fg={theme.textDim} wrapMode="none" />
            <text content="keys live in that user's authorized_keys. Writing another" fg={theme.textDim} wrapMode="none" />
            <text content="user's file needs root — so Spinup logs in as the server's" fg={theme.textDim} wrapMode="none" />
            <text content="sudo user. (The SpinupWP API can't manage SSH keys.)" fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Press s to connect sudo now (or S on the server), then" fg={theme.textFaint} wrapMode="none" />
            <text content="press K on the site again." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "loading") {
      return (
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content="  Finding your SSH keys…" fg={theme.textDim} />
        </box>
      )
    }

    if (dp === "pick") {
      return (
        <Panel title=" Choose keys to grant " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            {keys.map((k, i) => {
              const sel = i === index
              const checked = selected.has(k.id)
              const tag = k.kind === "machine" ? "machine" : "personal"
              const tagFg = sel ? theme.text : k.kind === "machine" ? theme.brand : theme.accent
              return (
                <box key={k.id} style={{ flexDirection: "row", height: 1, backgroundColor: sel ? theme.selectedBg : undefined }}>
                  <text content={(sel ? "❯ " : "  ") + (checked ? "[x] " : "[ ] ")} fg={checked ? theme.good : theme.textDim} style={{ flexShrink: 0 }} />
                  <text content={truncate(k.label || k.source, 40)} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  <text content={" " + tag} fg={tagFg} style={{ flexShrink: 0 }} />
                </box>
              )
            })}
            <box style={{ height: 1 }} />
            <text content="Personal keys log you in as yourself; the machine key is" fg={theme.textFaint} wrapMode="none" />
            <text content="Spinup's own identity for unattended automation." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "scope") {
      const opts = [
        { label: "Just this site", sub: site!.domain },
        { label: `All ${serverSites.length} sites on this server`, sub: server?.name ?? "" },
      ]
      return (
        <Panel title=" Grant to " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            {opts.map((o, i) => {
              const sel = i === scopeIndex
              return (
                <box key={i} style={{ flexDirection: "row", height: 1, backgroundColor: sel ? theme.selectedBg : undefined }}>
                  <text content={(sel ? "❯ " : "  ") + (sel ? "(•) " : "( ) ")} fg={sel ? theme.good : theme.textDim} style={{ flexShrink: 0 }} />
                  <text content={o.label} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                  <text content={truncate(o.sub, 26) + " "} fg={sel ? theme.text : theme.textFaint} style={{ flexShrink: 0 }} wrapMode="none" />
                </box>
              )
            })}
            <box style={{ height: 1 }} />
            <text content="All sites: the same idempotent append runs on each — keys" fg={theme.textFaint} wrapMode="none" />
            <text content="already present are skipped." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "confirm") {
      const n = targetSites.length
      const single = n === 1
      const displayLines = selectedKeys.map((k) => `…${k.kind === "machine" ? "spinup-tui" : "ed25519"}… ${k.label}`)
      const script = single ? buildGrantScript(siteUser, targetSites[0].domain, displayLines) : null
      return (
        <Panel title=" Confirm — privileged write " active>
          <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content={`Add ${selectedKeys.length} key${selectedKeys.length === 1 ? "" : "s"} to `} fg={theme.text} wrapMode="none" />
              <text content={single ? `${siteUser}@${targetSites[0].domain}` : `${n} sites on ${server?.name ?? ""}`} fg={theme.accent} wrapMode="none" />
            </box>
            <box style={{ flexDirection: "row" }}>
              <text content="via sudo as " fg={theme.textDim} wrapMode="none" />
              <text content={sudoUser ?? "—"} fg={theme.good} wrapMode="none" />
            </box>
            {selectedKeys.map((k) => (
              <box key={k.id} style={{ flexDirection: "row" }}>
                <text content="  • " fg={theme.textFaint} wrapMode="none" />
                <text content={truncate(k.label || k.source, 44)} fg={theme.textDim} wrapMode="none" />
                <text content={`  (${k.kind})`} fg={k.kind === "machine" ? theme.brand : theme.accent} wrapMode="none" />
              </box>
            ))}
            <box style={{ height: 1 }} />
            {single ? (
              <>
                <text content="Runs on the server (idempotent — re-running is a no-op):" fg={theme.textFaint} wrapMode="none" />
                <box style={{ flexDirection: "column", backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1 }}>
                  {script!.split("\n").map((line, i) => (
                    <text key={i} content={line} fg={theme.textDim} wrapMode="none" />
                  ))}
                </box>
              </>
            ) : (
              <text content={`The same idempotent append runs on each of the ${n} sites.`} fg={theme.textFaint} wrapMode="none" />
            )}
            <box style={{ height: 1 }} />
            <text content="This is Spinup's most powerful write. Press y to continue." fg={theme.warn} wrapMode="none" />
            <text content="y confirm · ← back · Esc cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "running") {
      const n = targetSites.length
      return (
        <Panel title=" Granting " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <Spinner />
              <text content={`  Granting to ${n} site${n === 1 ? "" : "s"} — ${settledCount}/${n} done`} fg={theme.textDim} wrapMode="none" />
            </box>
            {failedSites.length > 0 && (
              <text content={`${doneCount} ok · ${failedSites.length} failed so far`} fg={theme.textFaint} wrapMode="none" />
            )}
            <box style={{ height: 1 }} />
            <text content="You can press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    if (dp === "done") {
      const n = targetSites.length
      return (
        <Panel title={failedSites.length > 0 ? " Done — with errors " : " Done "} active>
          <box style={{ flexDirection: "column", width: 70, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content={failedSites.length > 0 ? "⚠ " : "✓ "} fg={failedSites.length > 0 ? theme.warn : theme.good} />
              <text content={`Granted on ${doneCount} of ${n} site${n === 1 ? "" : "s"}`} fg={theme.text} wrapMode="none" />
            </box>
            {failedSites.length > 0 && (
              <>
                <box style={{ height: 1 }} />
                <text content="Failed:" fg={theme.bad} wrapMode="none" />
                {failedSites.slice(0, 6).map((s) => (
                  <box key={s.id} style={{ flexDirection: "row" }}>
                    <text content={`  ✕ ${truncate(s.domain, 30)}  `} fg={theme.bad} wrapMode="none" />
                    <text content={truncate(keyGrants.get(s.id)?.error ?? "", 30)} fg={theme.textFaint} wrapMode="none" />
                  </box>
                ))}
                {failedSites.length > 6 && <text content={`  …${failedSites.length - 6} more`} fg={theme.textFaint} wrapMode="none" />}
              </>
            )}
            <box style={{ height: 1 }} />
            <text content={failedSites.length > 0 ? "r retry the failed · Esc close" : "Esc to close"} fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // error (loading keys failed)
    return (
      <Panel title=" Grant failed " active>
        <box style={{ flexDirection: "column", width: 72, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${loadError ?? "Something went wrong."}`} fg={theme.bad} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="r retry · Esc close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "disconnected":
        return [
          { key: "s", label: "connect sudo" },
          { key: "esc", label: "close" },
        ]
      case "pick":
        return [
          { key: "↑↓", label: "key" },
          { key: "space", label: "toggle" },
          { key: "⏎", label: canScope ? "scope" : "next" },
          { key: "esc", label: "cancel" },
        ]
      case "scope":
        return [
          { key: "↑↓", label: "scope" },
          { key: "⏎", label: "next" },
          { key: "←", label: "back" },
          { key: "esc", label: "cancel" },
        ]
      case "confirm":
        return [
          { key: "y", label: "confirm" },
          { key: "←", label: "back" },
          { key: "esc", label: "cancel" },
        ]
      case "done":
        return failedSites.length > 0
          ? [
              { key: "r", label: "retry failed" },
              { key: "esc", label: "close" },
            ]
          : [{ key: "esc", label: "close" }]
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

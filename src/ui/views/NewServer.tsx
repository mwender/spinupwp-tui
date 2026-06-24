// "Create a new server" overlay (backlog item 5, build 1) — the standalone
// server-creation action the clone wizard will later reuse.
//
// Opened with `c` on a selected server (Servers tab). Seeds the form by MATCHING
// the selected server's provider/region/size, prices it from the provider
// metadata, suggests a hostname from the fleet's naming convention, then confirms
// before firing POST /servers. The actual create + ~10-min event poll live in the
// store (`startNewServer`), so closing this modal (Esc) doesn't abandon the build.
//
// The API exposes no endpoint to list an account's server providers, so the
// numeric server_provider id is configured (config.json `serverProviders`), the
// same way accountSlug is. Without it the overlay opens in a "blocked" state that
// explains how to set it.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered, Field } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, isNewServerInFlight } from "../store.tsx"
import { moveSelection } from "../List.tsx"
import { openUrl } from "../../lib/open.ts"
import {
  providerKeyFromName,
  providerLabel,
  sizeBySlug,
  regionBySlug,
  sizesForRegion,
  formatSize,
  formatCost,
  suggestServerName,
} from "../../lib/serverCreate.ts"
import type { CreateServerPayload } from "../../api/types.ts"

type Phase = "blocked" | "loading" | "form" | "sizes" | "name" | "confirm" | "tracking" | "done" | "error"

export function NewServer() {
  const store = useStore()
  const {
    newServerSource: source,
    setNewServerSource,
    servers,
    serverProviders,
    providerMetadata,
    providerMetadataLoading,
    providerMetadataError,
    loadProviderMetadata,
    newServerJob,
    startNewServer,
    clearNewServer,
    accountSlug,
    setInputMode,
  } = store

  const providerKey = providerKeyFromName(source?.provider_name)
  const providerRef = providerKey ? serverProviders[providerKey] : undefined
  const md = providerKey ? providerMetadata.get(providerKey) : undefined
  const mdLoading = providerKey ? providerMetadataLoading.has(providerKey) : false
  const mdError = providerKey ? providerMetadataError.get(providerKey) : undefined

  // Why we can't proceed, if anything (checked before touching the network).
  const blockedReason: "provider-map" | "no-id" | "no-specs" | null = !source
    ? null
    : !providerKey
      ? "provider-map"
      : !providerRef
        ? "no-id"
        : !source.region || !source.size
          ? "no-specs"
          : null

  const [phase, setPhase] = useState<Phase>(() => {
    if (newServerJob && isNewServerInFlight(newServerJob)) return "tracking"
    if (blockedReason) return "blocked"
    return "loading"
  })
  const [sizeSlug, setSizeSlug] = useState<string>(source?.size ?? "")
  const [backups, setBackups] = useState(false)
  const [hostname, setHostname] = useState<string>("")
  const [sizeIndex, setSizeIndex] = useState(0)

  // Seed the hostname suggestion once the fleet is known.
  useEffect(() => {
    setHostname(suggestServerName(servers))
  }, [servers])

  // Kick off the metadata fetch while in "loading"; flip to the form once it's in.
  useEffect(() => {
    if (phase !== "loading" || !providerKey) return
    if (md) {
      setPhase("form")
    } else if (!mdLoading && !mdError) {
      loadProviderMetadata(providerKey)
    }
  }, [phase, providerKey, md, mdLoading, mdError, loadProviderMetadata])

  // The name sub-form owns the keyboard (suppress global shortcuts while typing).
  useEffect(() => {
    setInputMode(phase === "name")
    return () => setInputMode(false)
  }, [phase, setInputMode])

  // Follow the store job once we've fired (mirrors PhpUpgrade): a settled failure
  // shows the error; "done" shows success; anything else is still in flight.
  const dp: Phase =
    phase !== "tracking"
      ? phase
      : !newServerJob
        ? "tracking"
        : newServerJob.status === "failed"
          ? "error"
          : newServerJob.status === "done"
            ? "done"
            : "tracking"

  const region = regionBySlug(md, source?.region)
  const size = sizeBySlug(md, sizeSlug)
  const regionSizes = sizesForRegion(md, source?.region)

  const close = () => {
    setInputMode(false)
    // Leave an in-flight build running; only drop a settled job so reopening is fresh.
    if (newServerJob && !isNewServerInFlight(newServerJob)) clearNewServer()
    setNewServerSource(null)
  }

  const fire = () => {
    if (!source || !providerRef || !source.region || !sizeSlug) return
    const name = hostname.trim()
    if (!name) return setPhase("name")
    const payload: CreateServerPayload = {
      server_provider: {
        id: providerRef.id,
        region: source.region,
        size: sizeSlug,
        enable_backups: backups,
      },
      hostname: name,
      ...(source.timezone ? { timezone: source.timezone } : {}),
      ...(providerRef.databaseProviderId ? { database_provider: { id: providerRef.databaseProviderId } } : {}),
    }
    startNewServer(payload, name)
    setPhase("tracking")
  }

  useKeyboard((key) => {
    const name = key.name ?? ""

    // Name sub-form: the <input> handles text + Enter (onSubmit); we only cancel.
    if (dp === "name") {
      if (name === "escape") return setPhase("form")
      return
    }

    if (name === "escape" || name === "q") return close()

    if (dp === "blocked") {
      if (name === "w" && accountSlug) openUrl(`https://spinupwp.app/${accountSlug}`)
      return
    }

    if (dp === "loading") {
      // Retry a failed metadata fetch (clears the error and re-requests).
      if (name === "r" && providerKey && mdError) loadProviderMetadata(providerKey)
      return
    }

    if (dp === "form") {
      switch (name) {
        case "e":
          if (!md) return
          setSizeIndex(Math.max(0, regionSizes.findIndex((s) => s.slug === sizeSlug)))
          return setPhase("sizes")
        case "b":
          return setBackups((v) => !v)
        case "r":
          return setPhase("name")
        case "return":
        case "right":
        case "l":
          return setPhase("confirm")
      }
      return
    }

    if (dp === "sizes") {
      switch (name) {
        case "up":
        case "k":
          return setSizeIndex((i) => moveSelection(i, -1, regionSizes.length))
        case "down":
        case "j":
          return setSizeIndex((i) => moveSelection(i, 1, regionSizes.length))
        case "return":
        case "right":
        case "l": {
          const picked = regionSizes[sizeIndex]
          if (picked) setSizeSlug(picked.slug)
          return setPhase("form")
        }
        case "left":
        case "h":
          return setPhase("form")
      }
      return
    }

    if (dp === "confirm") {
      if (name === "y") return fire()
      if (name === "left" || name === "h") return setPhase("form")
      return
    }

    if (dp === "error") {
      if (name === "r") {
        clearNewServer()
        setPhase(blockedReason ? "blocked" : "form")
      }
      return
    }
  })

  if (!source) return null

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
        <text content="✦ New server  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={hostname || "name it below"} fg={hostname ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={`match ${truncate(source.name, 24)}`} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "blocked") return renderBlocked()

    if (dp === "loading") {
      return (
        <box style={{ flexDirection: "column", alignItems: "center" }}>
          {mdError ? (
            <>
              <text content={`✕ ${mdError}`} fg={theme.bad} wrapMode="none" />
              <box style={{ height: 1 }} />
              <text content="r retry · Esc to close" fg={theme.textFaint} />
            </>
          ) : (
            <box style={{ flexDirection: "row" }}>
              <Spinner />
              <text content={`  Loading ${providerKey ? providerLabel(providerKey) : ""} sizes & pricing…`} fg={theme.textDim} />
            </box>
          )}
        </box>
      )
    }

    if (dp === "sizes") return renderSizes()
    if (dp === "name") return renderName()
    if (dp === "confirm") return renderConfirm()
    if (dp === "tracking") return renderTracking()
    if (dp === "done") return renderDone()
    if (dp === "error") return renderError()
    return renderForm()
  }

  function renderForm() {
    return (
      <Panel title=" New server — matching specs " active>
        <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
          <Field label="Provider" value={providerKey ? providerLabel(providerKey) : (source!.provider_name ?? "—")} />
          <Field label="Region" value={region ? `${region.slug} (${region.name})` : (source!.region ?? "—")} />
          <Field
            label="Size"
            value={size ? `${size.slug} — ${formatSize(size)}` : (sizeSlug || "—")}
            valueColor={theme.text}
          />
          <Field label="Cost" value={formatCost(size, backups)} valueColor={theme.good} />
          <Field label="Backups" value={backups ? "on" : "off"} valueColor={backups ? theme.good : theme.textFaint} />
          <box style={{ height: 1 }} />
          <box style={{ flexDirection: "row" }}>
            <text content="Name      " fg={theme.textDim} />
            <text content={hostname || "—"} fg={hostname ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
          <box style={{ height: 1 }} />
          <text content="e size · b backups · r rename · ⏎ review" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderSizes() {
    return (
      <Panel title=" Choose a size " active>
        <box style={{ flexDirection: "column", width: 62 }}>
          {regionSizes.map((s, i) => {
            const selected = i === sizeIndex
            const isCurrent = s.slug === sizeSlug
            const fg = selected ? theme.text : isCurrent ? theme.accent : theme.textDim
            return (
              <box key={s.slug} style={{ flexDirection: "row", height: 1, backgroundColor: selected ? theme.selectedBg : undefined }}>
                <text content={(selected ? "❯ " : "  ") + s.slug} fg={fg} style={{ flexGrow: 1, flexShrink: 1 }} wrapMode="none" />
                <text content={formatSize(s) + "  "} fg={selected ? theme.text : theme.textFaint} style={{ flexShrink: 0 }} wrapMode="none" />
                <text content={formatCost(s, backups)} fg={selected ? theme.text : theme.good} style={{ flexShrink: 0 }} />
              </box>
            )
          })}
          <box style={{ height: 1 }} />
          <text content="↑↓ choose · ⏎ select · ← back" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderConfirm() {
    return (
      <Panel title=" Confirm — this provisions a real server " active>
        <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="Create " fg={theme.text} />
            <text content={hostname} fg={theme.accent} wrapMode="none" />
          </box>
          <box style={{ height: 1 }} />
          <Field label="Provider" value={providerKey ? providerLabel(providerKey) : "—"} />
          <Field label="Region" value={region ? `${region.slug} (${region.name})` : (source!.region ?? "—")} />
          <Field label="Size" value={size ? `${size.slug} — ${formatSize(size)}` : sizeSlug} />
          <Field label="Backups" value={backups ? "on" : "off"} valueColor={backups ? theme.good : theme.textFaint} />
          <box style={{ flexDirection: "row" }}>
            <text content="Cost      " fg={theme.textDim} />
            <text content={formatCost(size, backups)} fg={theme.good} />
            <text content="  — billed by your provider" fg={theme.textFaint} wrapMode="none" />
          </box>
          <box style={{ height: 1 }} />
          <text content="Provisioning takes ~10 minutes." fg={theme.textDim} wrapMode="none" />
          <text content="Press y to create · ← to go back · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderTracking() {
    return (
      <box style={{ flexDirection: "column", alignItems: "center" }}>
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content={`  Provisioning ${hostname} — ${newServerJob?.status ?? "queued"}…`} fg={theme.textDim} />
        </box>
        <box style={{ height: 1 }} />
        <text content="This takes ~10 min. Press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
      </box>
    )
  }

  function renderDone() {
    return (
      <Panel title=" Server created " active>
        <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="✓ " fg={theme.good} />
            <text content={hostname} fg={theme.accent} wrapMode="none" />
            <text content=" is up." fg={theme.text} />
          </box>
          <box style={{ height: 1 }} />
          <text content="It's in your Servers list now." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Esc to close" fg={theme.textFaint} />
        </box>
      </Panel>
    )
  }

  function renderError() {
    return (
      <Panel title=" Create failed " active>
        <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${newServerJob?.error ?? "Something went wrong."}`} fg={theme.bad} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Press r to adjust and try again · Esc to close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderBlocked() {
    if (blockedReason === "provider-map") {
      return (
        <Panel title=" Can't match this provider " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`Couldn't map "${source!.provider_name ?? "this server"}" to a SpinupWP provider.`} fg={theme.warn} wrapMode="none" />
            <text content="Server creation supports DigitalOcean, Vultr, Linode, Hetzner." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    if (blockedReason === "no-specs") {
      return (
        <Panel title=" Can't read the source specs " active>
          <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
            <text content="This server is missing a region or size, so there's nothing to match." fg={theme.warn} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    // no-id
    return (
      <Panel title=" Set your provider id first " active>
        <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`Creating a ${providerKey ? providerLabel(providerKey) : ""} server needs its SpinupWP`} fg={theme.warn} wrapMode="none" />
          <text content="server-provider id, which the API doesn't expose." fg={theme.warn} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Find it in SpinupWP → Account Settings → Server Providers," fg={theme.textDim} wrapMode="none" />
          <text content="then add it to your config.json:" fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content={`  "serverProviders": { "${providerKey}": { "id": 12345 } }`} fg={theme.accent} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text
            content={accountSlug ? "w opens SpinupWP · Esc to close" : "Esc to close"}
            fg={theme.textFaint}
            wrapMode="none"
          />
        </box>
      </Panel>
    )
  }

  function renderName() {
    return (
      <Panel title=" Name the server " active>
        <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
          <text content="Hostname (letters, numbers, dashes, periods)" fg={theme.accent} wrapMode="none" />
          <input
            focused
            value={hostname}
            placeholder="web1.example.com"
            onInput={setHostname}
            onSubmit={() => setPhase("form")}
            style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
          />
          <box style={{ height: 1 }} />
          <text content="A conventional name like web12.example.com keeps your fleet tidy." fg={theme.textFaint} wrapMode="none" />
          <text content="Enter to accept · Esc to go back" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "form":
        return [
          { key: "e", label: "size" },
          { key: "b", label: "backups" },
          { key: "r", label: "rename" },
          { key: "⏎", label: "review" },
          { key: "esc", label: "cancel" },
        ]
      case "sizes":
        return [
          { key: "↑↓/jk", label: "size" },
          { key: "⏎", label: "select" },
          { key: "←", label: "back" },
        ]
      case "name":
        return [
          { key: "⏎", label: "accept" },
          { key: "esc", label: "back" },
        ]
      case "confirm":
        return [
          { key: "y", label: "create" },
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

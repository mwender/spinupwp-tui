// "Create a new server" overlay (backlog item 5, build 1) — the standalone
// server-creation action the clone wizard will later reuse.
//
// Opened with `c` on a selected server (Servers tab). Seeds the form by MATCHING
// the selected server's provider/region/size, prices it from the provider
// metadata, suggests a hostname from the fleet's naming convention, then confirms
// before firing POST /servers. The actual create + ~10-min event poll live in the
// store (`startNewServer`), so closing this modal (Esc) doesn't abandon the build.
//
// You can switch to any supported provider (DigitalOcean / Vultr / Linode /
// Hetzner). The API exposes no endpoint to list an account's server providers, so
// each provider's numeric id is captured in-app the first time it's used and saved
// to config.json (the same way accountSlug is configured). Region + size are
// provider-specific, so switching provider re-defaults them from that provider's
// catalog.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered, Field } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore, isNewServerInFlight } from "../store.tsx"
import { moveSelection } from "../List.tsx"
import { openUrl } from "../../lib/open.ts"
import { serverProvidersSettingsUrl } from "../../lib/spinupweb.ts"
import {
  providerKeyFromName,
  providerLabel,
  sizeBySlug,
  regionBySlug,
  sizesForRegion,
  matchSizeBySpec,
  parseSizeSpec,
  allRegions,
  firstRegion,
  formatSize,
  formatCost,
  suggestServerName,
  PROVIDER_KEYS,
  type ProviderKey,
} from "../../lib/serverCreate.ts"
import type { CreateServerPayload } from "../../api/types.ts"

type Phase =
  | "providers"
  | "provider"
  | "loading"
  | "form"
  | "regions"
  | "sizes"
  | "name"
  | "confirm"
  | "tracking"
  | "done"
  | "error"

// m:ss elapsed since a build was fired.
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function NewServer() {
  const store = useStore()
  const {
    newServerOpen,
    setNewServerOpen,
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
    saveServerProviderId,
    accountSlug,
    setInputMode,
  } = store

  const sourceProviderKey = providerKeyFromName(source?.provider_name)

  // The active provider (may differ from the source). Null only when the source's
  // provider can't be mapped — then we open the picker so the user chooses one.
  const [selectedProviderKey, setSelectedProviderKey] = useState<ProviderKey | null>(sourceProviderKey)
  // Which provider the id-capture form is collecting for (transient).
  const [providerCaptureKey, setProviderCaptureKey] = useState<ProviderKey | null>(null)

  const providerRef = selectedProviderKey ? serverProviders[selectedProviderKey] : undefined
  const md = selectedProviderKey ? providerMetadata.get(selectedProviderKey) : undefined
  const mdLoading = selectedProviderKey ? providerMetadataLoading.has(selectedProviderKey) : false
  const mdError = selectedProviderKey ? providerMetadataError.get(selectedProviderKey) : undefined

  const [phase, setPhase] = useState<Phase>(() => {
    if (newServerJob && isNewServerInFlight(newServerJob)) return "tracking"
    // Land on the form (defaulting to the source's provider) when it's already
    // linked; otherwise open the picker so the user can choose or add a provider.
    if (sourceProviderKey && serverProviders[sourceProviderKey]) return "loading"
    return "providers"
  })
  // Region + size start empty; seeded with real catalog values once metadata loads
  // (a Server's region/size are display codes, not slugs — see the seeding effect).
  const [regionSlug, setRegionSlug] = useState<string>("")
  const [sizeSlug, setSizeSlug] = useState<string>("")
  // The desired specs to carry across provider/region switches. Seeded from the
  // source server; updated whenever the user picks a size. So switching providers
  // keeps "the same size" (closest match in that provider's catalog) rather than
  // resetting to the cheapest, and a manual size choice sticks across switches.
  const [desiredSpec, setDesiredSpec] = useState(() => parseSizeSpec(source?.size))
  const [backups, setBackups] = useState(false)
  const [hostname, setHostname] = useState<string>("")
  const [providerIndex, setProviderIndex] = useState(() => {
    const i = sourceProviderKey ? PROVIDER_KEYS.indexOf(sourceProviderKey) : 0
    return i >= 0 ? i : 0
  })
  const [regionIndex, setRegionIndex] = useState(0)
  const [sizeIndex, setSizeIndex] = useState(0)
  const [providerIdInput, setProviderIdInput] = useState("")

  // Seed a hostname suggestion from the fleet, but never clobber a value the user
  // has already typed/submitted. The servers list refreshes mid-build, and an
  // unguarded re-seed here would overwrite the in-flight name with a new suggestion.
  useEffect(() => {
    setHostname((h) => h || suggestServerName(servers))
  }, [servers])

  // Kick off the metadata fetch while in "loading"; flip to the form once it's in.
  useEffect(() => {
    if (phase !== "loading" || !selectedProviderKey) return
    if (md) setPhase("form")
    else if (!mdLoading && !mdError) loadProviderMetadata(selectedProviderKey)
  }, [phase, selectedProviderKey, md, mdLoading, mdError, loadProviderMetadata])

  // Text sub-forms own the keyboard (suppress global shortcuts while typing).
  useEffect(() => {
    setInputMode(phase === "name" || phase === "provider")
    return () => setInputMode(false)
  }, [phase, setInputMode])

  // Default/validate region + size against the active provider's catalog. Runs on
  // load and whenever the provider or region changes. Source region/size are
  // display codes, so for the same provider we match by code/specs; for a
  // different provider we fall back to that catalog's first region + size.
  useEffect(() => {
    if (!md) return
    let region = regionBySlug(md, regionSlug)
    if (!region) {
      // Prefer the source server's region only when we're on its provider (a DO
      // region slug won't exist in Hetzner's catalog, and vice versa).
      const preferSource = selectedProviderKey === sourceProviderKey
      region = (preferSource ? regionBySlug(md, source?.region) : undefined) ?? firstRegion(md)
    }
    const rSlug = region?.slug ?? ""
    if (rSlug !== regionSlug) setRegionSlug(rSlug)

    const sizes = sizesForRegion(md, rSlug)
    if (!sizes.find((s) => s.slug === sizeSlug)) {
      // Carry the desired spec into this region's sizes (closest match); only fall
      // back to the cheapest when nothing matches. Region-scoped so we never pick a
      // size the region doesn't offer.
      const matched = matchSizeBySpec(sizes, desiredSpec.vcpus, desiredSpec.memoryMb)
      const next = matched ?? sizes[0]?.slug ?? ""
      if (next !== sizeSlug) setSizeSlug(next)
    }
  }, [md, selectedProviderKey, regionSlug, desiredSpec]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const region = regionBySlug(md, regionSlug)
  const size = sizeBySlug(md, sizeSlug)
  const regionSizes = sizesForRegion(md, regionSlug)
  const regionList = allRegions(md)

  // What to DISPLAY as the server name: once fired, the job holds the actual
  // submitted name (source of truth); before that, it's the editable field.
  const displayName = newServerJob?.hostname || hostname

  // Tick once a second while a build is in flight so the elapsed readout advances.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (dp !== "tracking") return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [dp])

  const close = () => {
    setInputMode(false)
    if (newServerJob && !isNewServerInFlight(newServerJob)) clearNewServer()
    setNewServerOpen(false)
    setNewServerSource(null)
  }

  // Switch to (or add) a provider from the picker.
  const chooseProvider = (key: ProviderKey) => {
    if (!serverProviders[key]) {
      // Not linked yet → capture its id first.
      setProviderCaptureKey(key)
      setProviderIdInput("")
      return setPhase("provider")
    }
    if (key !== selectedProviderKey) {
      setSelectedProviderKey(key)
      setRegionSlug("") // re-default region + size for the new provider's catalog
      setSizeSlug("")
      return setPhase(providerMetadata.has(key) ? "form" : "loading")
    }
    setPhase("form")
  }

  const saveProviderId = () => {
    const id = parseInt(providerIdInput.trim(), 10)
    const key = providerCaptureKey
    if (!key || !Number.isFinite(id) || id <= 0) return
    saveServerProviderId(key, id)
    setSelectedProviderKey(key)
    setRegionSlug("")
    setSizeSlug("")
    setPhase("loading") // metadata loads next, then the form
  }

  const fire = () => {
    if (!providerRef || !regionSlug || !sizeSlug) return
    const name = hostname.trim()
    if (!name) return setPhase("name")
    const payload: CreateServerPayload = {
      server_provider: {
        id: providerRef.id,
        region: region?.slug ?? regionSlug,
        size: sizeSlug,
        enable_backups: backups,
      },
      hostname: name,
      ...(source?.timezone ? { timezone: source.timezone } : {}),
      ...(providerRef.databaseProviderId ? { database_provider: { id: providerRef.databaseProviderId } } : {}),
    }
    startNewServer(payload, name)
    setPhase("tracking")
  }

  useKeyboard((key) => {
    const name = key.name ?? ""

    // Text sub-forms: the <input> handles text + Enter (onSubmit); we only cancel.
    if (dp === "provider") {
      if (name === "escape") return setPhase("providers")
      return
    }
    if (dp === "name") {
      if (name === "escape") return setPhase("form")
      return
    }

    // Esc steps back one level from the list sub-screens (q still abandons the
    // whole overlay via the catch-all below). regions/sizes are only reachable
    // from the form, so Esc always returns there; the providers screen doubles as
    // the entry point when no provider is linked, so it only steps back when we
    // came from a loaded form (same guard ←/h uses).
    if (name === "escape") {
      if (dp === "regions" || dp === "sizes" || dp === "confirm") return setPhase("form")
      if (dp === "providers") return selectedProviderKey && md ? setPhase("form") : close()
    }

    if (name === "escape" || name === "q") return close()

    if (dp === "loading") {
      if (name === "r" && selectedProviderKey && mdError) loadProviderMetadata(selectedProviderKey)
      return
    }

    if (dp === "providers") {
      switch (name) {
        case "up":
        case "k":
          return setProviderIndex((i) => moveSelection(i, -1, PROVIDER_KEYS.length))
        case "down":
        case "j":
          return setProviderIndex((i) => moveSelection(i, 1, PROVIDER_KEYS.length))
        case "return":
        case "right":
        case "l":
          return chooseProvider(PROVIDER_KEYS[providerIndex])
        case "w":
          if (accountSlug) openUrl(serverProvidersSettingsUrl(accountSlug))
          return
        case "left":
        case "h":
          if (selectedProviderKey && md) return setPhase("form")
          return
      }
      return
    }

    if (dp === "form") {
      switch (name) {
        case "p":
          setProviderIndex(Math.max(0, PROVIDER_KEYS.indexOf(selectedProviderKey as ProviderKey)))
          return setPhase("providers")
        case "g":
          if (!md) return
          setRegionIndex(Math.max(0, regionList.findIndex((r) => r.slug === regionSlug)))
          return setPhase("regions")
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
          if (regionSlug && sizeSlug) setPhase("confirm")
          return
      }
      return
    }

    if (dp === "regions") {
      switch (name) {
        case "up":
        case "k":
          return setRegionIndex((i) => moveSelection(i, -1, regionList.length))
        case "down":
        case "j":
          return setRegionIndex((i) => moveSelection(i, 1, regionList.length))
        case "return":
        case "right":
        case "l": {
          const picked = regionList[regionIndex]
          if (picked) setRegionSlug(picked.slug)
          return setPhase("form")
        }
        case "left":
        case "h":
          return setPhase("form")
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
          if (picked) {
            setSizeSlug(picked.slug)
            // Remember this choice so switching providers keeps the same size.
            setDesiredSpec({ vcpus: picked.vcpus, memoryMb: picked.memory })
          }
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
        setPhase("form")
      }
      return
    }
  })

  if (!newServerOpen) return null

  const titleProvider = selectedProviderKey ? providerLabel(selectedProviderKey) : "choose a provider"

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
        // 240 so it layers ABOVE the clone wizard (218) when reused as that flow's
        // "New server" step; standalone use is unaffected.
        zIndex: 240,
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
        <text content={displayName || "name it below"} fg={displayName ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={truncate(titleProvider, 24)} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "providers") return renderProviders()
    if (dp === "provider") return renderProvider()

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
              <text content={`  Loading ${selectedProviderKey ? providerLabel(selectedProviderKey) : ""} sizes & pricing…`} fg={theme.textDim} />
            </box>
          )}
        </box>
      )
    }

    if (dp === "regions") return renderRegions()
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
      <Panel title=" New server " active>
        <box style={{ flexDirection: "column", width: 62, paddingTop: 1, paddingBottom: 1 }}>
          <Field label="Provider" value={selectedProviderKey ? providerLabel(selectedProviderKey) : "—"} />
          <Field label="Region" value={region ? `${region.slug} (${region.name})` : (regionSlug || "—")} />
          <Field label="Size" value={size ? `${size.slug} — ${formatSize(size)}` : (sizeSlug || "—")} />
          <Field label="Cost" value={formatCost(size, backups)} valueColor={theme.good} />
          <Field label="Backups" value={backups ? "on" : "off"} valueColor={backups ? theme.good : theme.textFaint} />
          <box style={{ height: 1 }} />
          <box style={{ flexDirection: "row" }}>
            <text content="Name      " fg={theme.textDim} />
            <text content={hostname || "—"} fg={hostname ? theme.text : theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
          <box style={{ height: 1 }} />
          <text content="p provider · g region · e size" fg={theme.textFaint} wrapMode="none" />
          <text content="b backups · r rename · ⏎ review" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderProviders() {
    return (
      <Panel title=" Choose a provider " active>
        <box style={{ flexDirection: "column", width: 60 }}>
          {PROVIDER_KEYS.map((key, i) => {
            const selected = i === providerIndex
            const ref = serverProviders[key]
            const isCurrent = key === selectedProviderKey
            const fg = selected ? theme.text : isCurrent ? theme.accent : theme.textDim
            const status = ref ? `id ${ref.id}` : "needs id"
            const statusFg = selected ? theme.text : ref ? theme.textFaint : theme.warn
            return (
              <box key={key} style={{ flexDirection: "row", height: 1, backgroundColor: selected ? theme.selectedBg : undefined }}>
                <text content={(selected ? "❯ " : "  ") + providerLabel(key) + (isCurrent ? " ●" : "")} fg={fg} style={{ flexGrow: 1, flexShrink: 1 }} wrapMode="none" />
                <text content={status} fg={statusFg} style={{ flexShrink: 0 }} wrapMode="none" />
              </box>
            )
          })}
          <box style={{ height: 1 }} />
          <text content="Pick a linked provider, or one marked “needs id” to add it." fg={theme.textFaint} wrapMode="none" />
          <text
            content={accountSlug ? "↑↓ choose · ⏎ select / add · w find ids in SpinupWP" : "↑↓ choose · ⏎ select / add"}
            fg={theme.textFaint}
            wrapMode="none"
          />
        </box>
      </Panel>
    )
  }

  function renderRegions() {
    return (
      <Panel title=" Choose a region " active>
        <box style={{ flexDirection: "column", width: 60 }}>
          {regionList.map((rg, i) => {
            const selected = i === regionIndex
            const isCurrent = rg.slug === regionSlug
            const unavailable = rg.available === false
            const fg = selected ? theme.text : unavailable ? theme.textFaint : isCurrent ? theme.accent : theme.textDim
            return (
              <box key={rg.slug} style={{ flexDirection: "row", height: 1, backgroundColor: selected ? theme.selectedBg : undefined }}>
                <text content={(selected ? "❯ " : "  ") + rg.slug} fg={fg} style={{ flexShrink: 0 }} wrapMode="none" />
                <text content={`  ${rg.name}`} fg={selected ? theme.text : theme.textFaint} style={{ flexGrow: 1, flexShrink: 1 }} wrapMode="none" />
                {unavailable ? <text content="full" fg={selected ? theme.text : theme.warn} style={{ flexShrink: 0 }} /> : null}
              </box>
            )
          })}
          <box style={{ height: 1 }} />
          <text content="↑↓ choose · ⏎ select · ←/esc back" fg={theme.textFaint} wrapMode="none" />
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
          <text content="↑↓ choose · ⏎ select · ←/esc back" fg={theme.textFaint} wrapMode="none" />
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
          <text content="A conventional name like web12.example.com keeps your fleet tidy." fg={theme.textFaint} />
          <text content="Enter to accept · Esc to go back" fg={theme.textFaint} wrapMode="none" />
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
          <Field label="Provider" value={selectedProviderKey ? providerLabel(selectedProviderKey) : "—"} />
          <Field label="Region" value={region ? `${region.slug} (${region.name})` : regionSlug} />
          <Field label="Size" value={size ? `${size.slug} — ${formatSize(size)}` : sizeSlug} />
          <Field label="Backups" value={backups ? "on" : "off"} valueColor={backups ? theme.good : theme.textFaint} />
          <box style={{ flexDirection: "row" }}>
            <text content="Cost      " fg={theme.textDim} />
            <text content={formatCost(size, backups)} fg={theme.good} />
            <text content="  — billed by your provider" fg={theme.textFaint} wrapMode="none" />
          </box>
          <box style={{ height: 1 }} />
          <text content="Provisioning takes ~10 minutes." fg={theme.textDim} wrapMode="none" />
          <text content="Press y to create · ←/esc to go back · q to cancel" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderTracking() {
    const status = newServerJob?.status ?? "queued"
    const elapsed = newServerJob?.startedAt ? fmtElapsed(now - newServerJob.startedAt) : null
    return (
      <box style={{ flexDirection: "column", alignItems: "center" }}>
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content={`  Provisioning ${displayName}…`} fg={theme.textDim} />
        </box>
        <box style={{ height: 1 }} />
        <box style={{ flexDirection: "row" }}>
          <text content="Status " fg={theme.textFaint} />
          <text content={status} fg={theme.text} wrapMode="none" />
          {elapsed ? <text content={`   ·   elapsed ${elapsed}`} fg={theme.textFaint} wrapMode="none" /> : null}
        </box>
        <box style={{ height: 1 }} />
        <text content="Typically ~10 min. Press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
      </box>
    )
  }

  function renderDone() {
    return (
      <Panel title=" Server created " active>
        <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="✓ " fg={theme.good} style={{ flexShrink: 0 }} />
            <text content={displayName} fg={theme.accent} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
          <text content="It's up — and in your Servers list now." fg={theme.text} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Next: connect it with a vanity site" fg={theme.accent} wrapMode="none" />
          <text content="A brand-new server has no site, so there's nothing to attach an" fg={theme.textDim} />
          <text content="SSH key to and no way to reach it from Spinup. Creating a vanity" fg={theme.textDim} />
          <text content="site — a tiny placeholder at the server's own hostname — gives" fg={theme.textDim} />
          <text content="you that foothold. Open the server in your Servers list to do it." fg={theme.textDim} />
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

  function renderProvider() {
    const key = providerCaptureKey ?? selectedProviderKey
    return (
      <Panel title=" Link your server provider " active>
        <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`${key ? providerLabel(key) : "This provider"} isn't linked in Spinup yet.`} fg={theme.text} wrapMode="none" />
          <text content="Paste its SpinupWP provider id (Account Settings →" fg={theme.textDim} wrapMode="none" />
          <text content="Server Providers — the ID column):" fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <input
            focused
            value={providerIdInput}
            placeholder="e.g. 7577"
            onInput={setProviderIdInput}
            onSubmit={saveProviderId}
            style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
          />
          <box style={{ height: 1 }} />
          <text content="It's saved to your config — you only do this once per provider." fg={theme.textFaint} wrapMode="none" />
          <text content="⏎ save · Esc back to providers" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "providers": {
        const canGoBack = !!(selectedProviderKey && md)
        return [
          { key: "↑↓/jk", label: "provider" },
          { key: "⏎", label: "select / add" },
          ...(accountSlug ? [{ key: "w", label: "SpinupWP" }] : []),
          canGoBack ? { key: "←/esc", label: "back" } : { key: "esc", label: "cancel" },
        ]
      }
      case "provider":
        return [
          { key: "⏎", label: "save" },
          { key: "esc", label: "back" },
        ]
      case "form":
        return [
          { key: "p", label: "provider" },
          { key: "g", label: "region" },
          { key: "e", label: "size" },
          { key: "b", label: "backups" },
          { key: "r", label: "rename" },
          { key: "⏎", label: "review" },
        ]
      case "regions":
      case "sizes":
        return [
          { key: "↑↓/jk", label: dp === "regions" ? "region" : "size" },
          { key: "⏎", label: "select" },
          { key: "←/esc", label: "back" },
        ]
      case "name":
        return [
          { key: "⏎", label: "accept" },
          { key: "esc", label: "back" },
        ]
      case "confirm":
        return [
          { key: "y", label: "create" },
          { key: "←/esc", label: "back" },
          { key: "q", label: "cancel" },
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

// Focused TTL editor — Phase 3, the migration record manager's first write.
//
// Opened with Enter on a hosting record in the DNS inventory (one whose host we
// hold a verified API key for). This is NOT a zone editor: it reads and edits the
// ONE record it was handed (no zone listing), so the only records reachable here
// are a site's own hosting records — MX/TXT/DKIM/etc. are never even fetched. You
// change a single field — the TTL — through the same confirm-before-firing flow as
// the PHP upgrade. The write + its polling live in the store (startTtlChange), so
// closing this modal doesn't abandon a Route 53 change mid-propagation.
//
// Target/IP repointing (step 3 of the cutover loop) is the next write; for now only
// the TTL is editable, and only where that's well-defined — an alias / routing-policy
// / proxied record opens read-only with a short reason. The read is on-demand and
// ephemeral (no disk cache) — re-opening re-fetches.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { apiProviderFor, PROVIDER_REGISTRY, normNameservers, nameserversMatch } from "../../lib/providers.ts"
import { resolveZone } from "../../lib/dns.ts"
import { TTL_PRESETS, formatTtl, validateTtl, defaultTtlFor, type DnsRecord } from "../../lib/dnsRecords.ts"
import { StatusBar } from "../StatusBar.tsx"
import { Panel, Spinner, Centered } from "../components.tsx"
import { moveSelection } from "../List.tsx"
import { useStore } from "../store.tsx"
import { isTtlWriteInFlight } from "../store.tsx"

type Phase = "pick" | "custom" | "confirm" | "tracking"
type LoadState = "loading" | "ready" | "error"

// A TTL option in the picker. ttl = -1 is the "Custom…" sentinel.
interface TtlOption {
  ttl: number
  label: string
}
const CUSTOM_TTL = -1

export function DnsRecords() {
  const { dnsRecordsTarget, setDnsRecordsTarget, getZoneRecord, startTtlChange, clearTtlWrite, ttlWrites, setInputMode } = useStore()
  const target = dnsRecordsTarget
  const provider = target ? apiProviderFor(target.hostKey) : null
  const providerName = provider ? PROVIDER_REGISTRY[provider].name : ""
  const { height } = useTerminalDimensions()

  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [record, setRecord] = useState<DnsRecord | null>(null)
  const [zoneId, setZoneId] = useState("")
  const [phase, setPhase] = useState<Phase>("pick")
  const [pickIndex, setPickIndex] = useState(0)
  const [custom, setCustom] = useState("")
  const [customError, setCustomError] = useState<string | null>(null)
  const [targetTtl, setTargetTtl] = useState<number | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  // Edit-time NS-match pre-flight: when the account's hosted-zone NS don't match
  // the FRESH live authoritative NS, this account isn't the one serving the domain
  // (a stale/duplicate zone) — editing it would be a silent no-op or, worse, edit
  // the wrong zone. We surface it and hard-stop writes. `null` = not yet known or
  // not checkable (e.g. Cloudflare, whose access is already NS-matched in Phase 2).
  const [ns, setNs] = useState<{ live: string[]; zone: string[] } | null>(null)
  const nsMismatch = ns != null && ns.live.length > 0 && ns.zone.length > 0 && !nameserversMatch(ns.zone, ns.live)

  const apex = target?.apex ?? ""

  // Load the single hosting record when the overlay opens. We re-dig the FRESH live
  // NS in parallel — the NS-match gate compares it against the zone's apex NS.
  useEffect(() => {
    if (!target) return
    let cancelled = false
    setLoadState("loading")
    setNs(null)
    void Promise.all([getZoneRecord(target.connId, target.apex, target.record.name, target.record.type), resolveZone(target.apex)]).then(([res, liveZone]) => {
      if (cancelled) return
      if (res.ok && res.record) {
        setRecord(res.record)
        setZoneId(res.zoneId)
        setLoadState("ready")
        // Open the picker cursor on the current value: a preset lands on its row; an
        // off-list TTL is prepended as "current" at index 0; null (CF auto) → 0.
        const i = TTL_PRESETS.findIndex((o) => o.ttl === res.record!.ttl)
        setPickIndex(i >= 0 ? i : 0)
        setNs({ live: normNameservers(liveZone?.nameservers), zone: normNameservers(res.apexNs) })
      } else {
        setLoadError(res.error ?? "Couldn't read this record.")
        setLoadState("error")
      }
    })
    return () => {
      cancelled = true
    }
  }, [target, getZoneRecord])

  // The custom-TTL input owns the keyboard while it's focused.
  useEffect(() => {
    setInputMode(phase === "custom")
    return () => setInputMode(false)
  }, [phase, setInputMode])

  // TTL options: presets, the record's current value when off-list, and a Custom… entry.
  const ttlOptions = useMemo<TtlOption[]>(() => {
    const opts: TtlOption[] = [...TTL_PRESETS]
    const cur = record?.ttl
    if (cur != null && !opts.some((o) => o.ttl === cur)) opts.unshift({ ttl: cur, label: "current" })
    opts.push({ ttl: CUSTOM_TTL, label: "Custom…" })
    return opts
  }, [record])

  // Tracking display derives from the store, like the PHP-upgrade overlay.
  const progress = activeKey ? ttlWrites.get(activeKey) : undefined
  const dp: Phase | "done" | "error" =
    phase !== "tracking"
      ? phase
      : !progress || isTtlWriteInFlight(progress)
        ? "tracking"
        : progress.status === "failed"
          ? "error"
          : "done"

  const blocked = loadState === "ready" && (nsMismatch || (record != null && !record.editable))

  const close = () => {
    // Drop a settled failure so its marker doesn't linger; an in-flight change
    // keeps polling in the store.
    if (activeKey && progress?.status === "failed") clearTtlWrite(activeKey)
    setInputMode(false)
    setDnsRecordsTarget(null)
  }

  const showFlash = (msg: string) => {
    setFlash(msg)
    setTimeout(() => setFlash(null), 2000)
  }

  const chooseTtl = (ttl: number) => {
    setTargetTtl(ttl)
    setPhase("confirm")
  }

  const submitCustom = () => {
    if (!provider) return
    const n = Number(custom.trim())
    const err = !custom.trim() || Number.isNaN(n) ? "Enter a TTL in seconds." : validateTtl(provider, n)
    if (err) return setCustomError(err)
    setCustomError(null)
    chooseTtl(n)
  }

  const fire = () => {
    if (!target || !record || targetTtl == null) return
    startTtlChange(target.connId, zoneId, record, targetTtl)
    setActiveKey(record.key)
    setPhase("tracking")
  }

  useKeyboard((key) => {
    const raw = key.name ?? ""
    const name = key.shift && raw.length === 1 ? raw.toUpperCase() : raw

    // Esc/q always backs out a step (or closes). In custom mode the input owns
    // typing — only Esc reaches us.
    if (phase === "custom") {
      if (raw === "escape") {
        setCustomError(null)
        setPhase("pick")
      }
      return
    }
    if (raw === "escape" || name === "q") {
      if (phase === "confirm") return setPhase("pick")
      // After a successful change, Esc closes back to the inventory — we KEEP the
      // settled write so its row there reflects the new TTL (the authoritative host
      // already has it); only failures are dropped (in close()).
      return close()
    }

    if (loadState !== "ready" || blocked) return

    if (phase === "pick") {
      switch (name) {
        case "up":
        case "k":
          return setPickIndex((i) => moveSelection(i, -1, ttlOptions.length))
        case "down":
        case "j":
          return setPickIndex((i) => moveSelection(i, 1, ttlOptions.length))
        case "return":
        case "right":
        case "l": {
          const opt = ttlOptions[pickIndex]
          if (!opt) return
          if (opt.ttl === CUSTOM_TTL) {
            setCustom(record ? String(defaultTtlFor(record)) : "")
            setCustomError(null)
            return setPhase("custom")
          }
          return chooseTtl(opt.ttl)
        }
      }
      return
    }

    if (phase === "confirm") {
      if (name === "y") return fire()
      if (name === "left" || name === "h") return setPhase("pick")
      return
    }

    if (dp === "error") {
      if (name === "r") {
        if (activeKey) clearTtlWrite(activeKey)
        setActiveKey(null)
        setPhase("pick")
      }
      return
    }
  })

  if (!target || !provider) return null

  const recLabel = `${truncate(target.record.name || "@", 32)} ${target.record.type}`

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 235 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content={`🔧 Edit TTL · ${recLabel}  `} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={`${truncate(apex, 28)} · ${providerName}`} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        {loadState === "loading" ? <Spinner color={theme.brand} interval={120} /> : null}
      </box>

      {nsMismatch && loadState === "ready" ? (
        <box style={{ flexDirection: "column", height: 2, backgroundColor: theme.bad, paddingLeft: 1, paddingRight: 1 }}>
          <text content={`⚠ This account's hosted zone isn't the one serving ${truncate(apex, 30)} live — TTL edits are blocked.`} fg={theme.bg} wrapMode="none" />
          <text content={`   live NS: ${truncate(ns!.live.join(" ") || "unknown", 50)}  ·  this zone: ${truncate(ns!.zone.join(" ") || "unknown", 50)}`} fg={theme.bg} wrapMode="none" />
        </box>
      ) : null}

      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
        {loadState === "loading" ? (
          <Centered>
            <text content="Reading record…" fg={theme.textDim} />
          </Centered>
        ) : loadState === "error" ? (
          <Centered>
            <text content={`✕ ${loadError}`} fg={theme.bad} wrapMode="none" />
          </Centered>
        ) : (
          <Centered>{renderBody()}</Centered>
        )}
      </box>

      <StatusBar hints={hints()} message={flash ?? undefined} messageColor={theme.brand} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (!record) return null
    const curLabel = formatTtl(record.ttl)

    // NS-mismatch is already shown as the banner; non-editable records open here.
    if (nsMismatch) {
      return (
        <Panel title=" Editing blocked " active>
          <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
            <text content="This connection can't safely edit this record — see the ⚠ above." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }
    if (!record.editable) {
      return (
        <Panel title=" Read-only record " active>
          <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content={`${truncate(record.name || "@", 28)} `} fg={theme.accent} wrapMode="none" />
              <text content={record.type} fg={theme.textDim} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content={`Can't edit this TTL — ${record.reason ?? "read-only"}.`} fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    if (phase === "pick") {
      return (
        <Panel title=" Choose a TTL " active>
          <box style={{ flexDirection: "column", width: 44 }}>
            <box style={{ flexDirection: "row" }}>
              <text content={`${truncate(record.name || "@", 28)} `} fg={theme.accent} wrapMode="none" />
              <text content={record.type} fg={theme.textDim} wrapMode="none" />
              <box style={{ flexGrow: 1 }} />
              <text content={`now ${curLabel}`} fg={theme.textFaint} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            {ttlOptions.map((o, i) => {
              const sel = i === pickIndex
              const isCustom = o.ttl === CUSTOM_TTL
              const isCurrent = o.ttl === record.ttl
              const text = isCustom ? "Custom…" : `${formatTtl(o.ttl)}  (${o.ttl}s)`
              const tag = isCurrent ? "  (current)" : ""
              return (
                <box key={o.label + o.ttl} style={{ flexDirection: "row", height: 1, backgroundColor: sel ? theme.selectedBg : undefined }}>
                  <text content={(sel ? "❯ " : "  ") + text} fg={sel ? theme.text : isCurrent ? theme.textFaint : theme.textDim} style={{ flexGrow: 1 }} wrapMode="none" />
                  <text content={tag} fg={sel ? theme.text : theme.textFaint} style={{ flexShrink: 0 }} />
                </box>
              )
            })}
          </box>
        </Panel>
      )
    }

    if (phase === "custom") {
      const inputStyle = { backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }
      return (
        <Panel title=" Custom TTL " active>
          <box style={{ flexDirection: "column", width: 48, paddingTop: 1, paddingBottom: 1 }}>
            <text content="TTL in seconds" fg={theme.accent} />
            <input focused value={custom} placeholder="e.g. 3600" onInput={setCustom} onSubmit={submitCustom} style={inputStyle} />
            <box style={{ height: 1 }} />
            {customError ? <text content={customError} fg={theme.bad} wrapMode="none" /> : <text content="⏎ to continue · Esc to go back" fg={theme.textFaint} wrapMode="none" />}
          </box>
        </Panel>
      )
    }

    if (phase === "confirm") {
      return (
        <Panel title=" Confirm TTL change " active>
          <box style={{ flexDirection: "column", width: 56, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content={`${truncate(record.name || "@", 28)} `} fg={theme.accent} wrapMode="none" />
              <text content={record.type} fg={theme.textDim} wrapMode="none" />
            </box>
            <box style={{ flexDirection: "row" }}>
              <text content={`TTL ${curLabel}`} fg={theme.textDim} />
              <text content="  →  " fg={theme.textFaint} />
              <text content={`${formatTtl(targetTtl)} (${targetTtl}s)`} fg={theme.good} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content={`This writes directly to ${providerName} — it's a live DNS change.`} fg={theme.textDim} wrapMode="none" />
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
            <text content={`  Setting TTL to ${formatTtl(targetTtl)} — ${progress?.status ?? "queued"}…`} fg={theme.textDim} />
          </box>
          <box style={{ height: 1 }} />
          <text content="You can press Esc — it keeps applying in the background." fg={theme.textFaint} wrapMode="none" />
        </box>
      )
    }

    if (dp === "done") {
      return (
        <Panel title=" Done " active>
          <box style={{ flexDirection: "column", width: 52, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="✓ " fg={theme.good} />
              <text content={`${truncate(record.name || "@", 24)} ${record.type}`} fg={theme.accent} wrapMode="none" />
              <text content={` TTL is now ${formatTtl(targetTtl)}`} fg={theme.text} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Esc to close · r in the inventory to refresh" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // error
    return (
      <Panel title=" Change failed " active>
        <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`✕ ${progress?.error ?? "Something went wrong."}`} fg={theme.bad} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Press r to choose another TTL · Esc to close" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    if (loadState !== "ready") return [{ key: "esc", label: "close" }]
    if (blocked) return [{ key: "esc", label: "close" }]
    switch (dp) {
      case "pick":
        return [
          { key: "↑↓/jk", label: "TTL" },
          { key: "⏎", label: "choose" },
          { key: "esc", label: "close" },
        ]
      case "custom":
        return [
          { key: "⏎", label: "continue" },
          { key: "esc", label: "back" },
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

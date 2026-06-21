// DNS records overlay — Phase 3, the module's first record-level write.
//
// Opened with Enter/t on an EDITABLE zone in the DNS inventory (one whose host we
// hold a verified API key for). Lists the zone's records straight from the host
// (Route 53 / Cloudflare) and lets you change a single field — the TTL — through
// the same confirm-before-firing flow as the PHP upgrade. The write + its polling
// live in the store (startTtlChange), so closing this modal doesn't abandon a
// Route 53 change mid-propagation.
//
// Only the TTL is editable here, and only where that's well-defined: alias /
// routing-policy / proxied records surface read-only with a short reason. Record
// listing is on-demand and ephemeral (no disk cache) — re-opening re-fetches.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { apiProviderFor, PROVIDER_REGISTRY, normNameservers, nameserversMatch } from "../../lib/providers.ts"
import { resolveZone } from "../../lib/dns.ts"
import { TTL_PRESETS, formatTtl, validateTtl, defaultTtlFor, type DnsRecord } from "../../lib/dnsRecords.ts"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { Panel, Spinner, Centered } from "../components.tsx"
import { useStore } from "../store.tsx"
import { isTtlWriteInFlight } from "../store.tsx"

const NAME_W = 30
const TYPE_W = 7
const TTL_W = 9
const FLAG_W = 11

type Phase = "list" | "pick" | "custom" | "confirm" | "tracking"
type LoadState = "loading" | "ready" | "error"

// A TTL option in the picker. ttl = -1 is the "Custom…" sentinel.
interface TtlOption {
  ttl: number
  label: string
}
const CUSTOM_TTL = -1

export function DnsRecords() {
  const { dnsRecordsTarget, setDnsRecordsTarget, listZoneRecords, startTtlChange, clearTtlWrite, ttlWrites, setInputMode } = useStore()
  const target = dnsRecordsTarget
  const provider = target ? apiProviderFor(target.hostKey) : null
  const providerName = provider ? PROVIDER_REGISTRY[provider].name : ""
  const { height } = useTerminalDimensions()

  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [records, setRecords] = useState<DnsRecord[]>([])
  const [zoneId, setZoneId] = useState("")
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>("list")
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

  // Load the zone's records when the overlay opens.
  useEffect(() => {
    if (!target) return
    let cancelled = false
    const apexLc = target.apex.toLowerCase()
    setLoadState("loading")
    setNs(null)
    // List the records and re-dig the FRESH live NS in parallel — the NS-match
    // gate compares the live NS against the zone's own apex NS record.
    void Promise.all([listZoneRecords(target.connId, target.apex), resolveZone(target.apex)]).then(([res, liveZone]) => {
      if (cancelled) return
      if (res.ok) {
        const sorted = [...res.records].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type))
        setRecords(sorted)
        setZoneId(res.zoneId)
        setLoadState("ready")
        // When opened from a specific inventory record, land the cursor on it.
        if (target.focus) {
          const fn = target.focus.name.toLowerCase()
          const i = sorted.findIndex((r) => r.name.toLowerCase() === fn && r.type === target.focus!.type)
          if (i >= 0) setIndex(i)
        }
        // The zone's declared NS = its apex NS record (Route 53 returns it; some
        // hosts don't, in which case we can't compare and don't block).
        const apexNs = res.records.find((r) => r.type === "NS" && r.name.toLowerCase() === apexLc)?.values ?? []
        setNs({ live: normNameservers(liveZone?.nameservers), zone: normNameservers(apexNs) })
      } else {
        setLoadError(res.error ?? "Couldn't list records.")
        setLoadState("error")
      }
    })
    return () => {
      cancelled = true
    }
  }, [target, listZoneRecords])

  // The custom-TTL input owns the keyboard while it's focused.
  useEffect(() => {
    setInputMode(phase === "custom")
    return () => setInputMode(false)
  }, [phase, setInputMode])

  const safeIndex = Math.min(index, Math.max(0, records.length - 1))
  const selected = records[safeIndex]

  // Reflect a settled success back into the row so the list shows the new TTL.
  useEffect(() => {
    if (!activeKey) return
    const p = ttlWrites.get(activeKey)
    if (p?.status === "done") {
      setRecords((rs) => rs.map((r) => (r.key === activeKey ? { ...r, ttl: p.ttl } : r)))
    }
  }, [ttlWrites, activeKey])

  // TTL options for the selected record: presets, the record's current value when
  // off-list, and a Custom… entry.
  const ttlOptions = useMemo<TtlOption[]>(() => {
    const opts: TtlOption[] = [...TTL_PRESETS]
    const cur = selected?.ttl
    if (cur != null && !opts.some((o) => o.ttl === cur)) opts.unshift({ ttl: cur, label: "current" })
    opts.push({ ttl: CUSTOM_TTL, label: "Custom…" })
    return opts
  }, [selected])

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

  const openPicker = () => {
    if (!selected) return
    if (nsMismatch) return showFlash("TTL edits blocked — this account's zone isn't serving the domain live (see ⚠).")
    if (!selected.editable) return showFlash(`Can't edit this TTL — ${selected.reason ?? "read-only"}.`)
    // Open the cursor on the current value when it's an option.
    const i = ttlOptions.findIndex((o) => o.ttl === selected.ttl)
    setPickIndex(i >= 0 ? i : 0)
    setPhase("pick")
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
    if (!target || !selected || targetTtl == null) return
    startTtlChange(target.connId, zoneId, selected, targetTtl)
    setActiveKey(selected.key)
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
      if (phase === "pick") return setPhase("list")
      if (phase === "confirm") return setPhase("pick")
      // After a successful change, Esc returns to the (now-updated) record list
      // rather than closing — so you can edit another record in one sitting.
      if (phase === "tracking" && dp === "done") {
        if (activeKey) clearTtlWrite(activeKey)
        setActiveKey(null)
        return setPhase("list")
      }
      return close()
    }

    if (loadState !== "ready") return

    if (phase === "list") {
      switch (name) {
        case "up":
        case "k":
          return setIndex((i) => moveSelection(i, -1, records.length))
        case "down":
        case "j":
          return setIndex((i) => moveSelection(i, 1, records.length))
        case "return":
        case "t":
        case "right":
        case "l":
          return openPicker()
      }
      return
    }

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
            setCustom(selected ? String(defaultTtlFor(selected)) : "")
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

  const listRows = Math.max(3, height - 7)

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 235 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content={`🔧 DNS records · ${truncate(apex, 36)}  `} fg={theme.brand} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={providerName} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        {loadState === "loading" ? <Spinner color={theme.brand} interval={120} /> : null}
      </box>

      {nsMismatch && loadState === "ready" ? (
        <box style={{ flexDirection: "column", height: 2, backgroundColor: theme.bad, paddingLeft: 1, paddingRight: 1 }}>
          <text content={`⚠ This account's hosted zone isn't the one serving ${truncate(apex, 30)} live — TTL edits are blocked.`} fg={theme.bg} wrapMode="none" />
          <text content={`   live NS: ${truncate(ns!.live.join(" ") || "unknown", 50)}  ·  this zone: ${truncate(ns!.zone.join(" ") || "unknown", 50)}`} fg={theme.bg} wrapMode="none" />
        </box>
      ) : null}

      {phase === "list" && loadState === "ready" ? renderListHeader() : null}

      <box style={{ flexGrow: 1, flexDirection: "column", paddingLeft: 1, paddingRight: 1 }}>
        {loadState === "loading" ? (
          <Centered>
            <text content="Listing records…" fg={theme.textDim} />
          </Centered>
        ) : loadState === "error" ? (
          <Centered>
            <text content={`✕ ${loadError}`} fg={theme.bad} wrapMode="none" />
          </Centered>
        ) : phase === "list" ? (
          renderList()
        ) : (
          <Centered>{renderEditor()}</Centered>
        )}
      </box>

      <StatusBar hints={hints()} message={flash ?? undefined} messageColor={theme.brand} showGlobal={false} />
    </box>
  )

  function renderListHeader() {
    return (
      <box style={{ flexDirection: "row", paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text content={"NAME".padEnd(NAME_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"TYPE".padEnd(TYPE_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"TTL".padEnd(TTL_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content={"".padEnd(FLAG_W)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
        <text content="VALUE" fg={theme.textFaint} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
      </box>
    )
  }

  function renderList() {
    return (
      <List
        items={records}
        selectedIndex={safeIndex}
        viewportRows={listRows}
        focused
        keyFor={(r) => r.key}
        emptyText="No records in this zone."
        renderRow={(r, sel) => {
          const wp = ttlWrites.get(r.key)
          const inFlight = isTtlWriteInFlight(wp)
          const nameFg = sel ? theme.text : r.editable ? theme.text : theme.textFaint
          const ttlFg = sel ? theme.text : r.editable ? theme.accent : theme.textFaint
          return (
            <>
              <text content={truncate(r.name || "@", NAME_W - 1).padEnd(NAME_W)} fg={nameFg} wrapMode="none" style={{ flexShrink: 0 }} />
              <text content={truncate(r.type, TYPE_W - 1).padEnd(TYPE_W)} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexShrink: 0 }} />
              {inFlight ? (
                <box style={{ flexDirection: "row", width: TTL_W, flexShrink: 0 }}>
                  <Spinner color={sel ? theme.text : theme.brand} interval={120} />
                  <text content={`→${formatTtl(wp!.ttl)}`} fg={sel ? theme.text : theme.warn} wrapMode="none" />
                </box>
              ) : (
                <text content={formatTtl(r.ttl).padEnd(TTL_W)} fg={ttlFg} wrapMode="none" style={{ flexShrink: 0 }} />
              )}
              <text
                content={(r.editable ? "" : `· ${r.reason ?? "read-only"}`).padEnd(FLAG_W)}
                fg={sel ? theme.text : theme.textFaint}
                wrapMode="none"
                style={{ flexShrink: 0 }}
              />
              <text content={truncate(r.values.join(" "), 80)} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
            </>
          )
        }}
      />
    )
  }

  function renderEditor() {
    if (!selected) return null
    const curLabel = formatTtl(selected.ttl)

    if (phase === "pick") {
      return (
        <Panel title=" Choose a TTL " active>
          <box style={{ flexDirection: "column", width: 44 }}>
            <box style={{ flexDirection: "row" }}>
              <text content={`${truncate(selected.name || "@", 28)} `} fg={theme.accent} wrapMode="none" />
              <text content={selected.type} fg={theme.textDim} wrapMode="none" />
              <box style={{ flexGrow: 1 }} />
              <text content={`now ${curLabel}`} fg={theme.textFaint} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            {ttlOptions.map((o, i) => {
              const sel = i === pickIndex
              const isCustom = o.ttl === CUSTOM_TTL
              const isCurrent = o.ttl === selected.ttl
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
              <text content={`${truncate(selected.name || "@", 28)} `} fg={theme.accent} wrapMode="none" />
              <text content={selected.type} fg={theme.textDim} wrapMode="none" />
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
              <text content={`${truncate(selected.name || "@", 24)} ${selected.type}`} fg={theme.accent} wrapMode="none" />
              <text content={` TTL is now ${formatTtl(targetTtl)}`} fg={theme.text} wrapMode="none" />
            </box>
            <box style={{ height: 1 }} />
            <text content="Esc to return to the records" fg={theme.textFaint} />
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
    if (loadState !== "ready" && phase === "list") return [{ key: "esc", label: "close" }]
    switch (dp) {
      case "list":
        return [
          { key: "↑↓/jk", label: "record" },
          { key: "t/⏎", label: "set TTL" },
          { key: "esc", label: "close" },
        ]
      case "pick":
        return [
          { key: "↑↓/jk", label: "TTL" },
          { key: "⏎", label: "choose" },
          { key: "esc", label: "back" },
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

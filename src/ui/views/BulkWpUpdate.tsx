// Bulk WordPress core update for a Stacks version group — `u` on a "WP x.y.z" row.
//
// check (SSH, every site, read-only) → plan → confirm → run → summary.
//
// The check comes first because the group itself is built from cached probes,
// which lag reality (sites auto-update); the plan is built from live versions.
// The plan defaults to the newest release in each site's own line (the low-risk
// security hotfix) with `m` switching to the newest release overall, and `space`
// leaves individual sites out. The run itself lives in ../wpCoreJobs.tsx (canary
// first, then a few at a time, one per server), so closing this overlay leaves it
// running; reopening shows its progress or its summary.

import { useEffect, useMemo, useState } from "react"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Spinner, Centered } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import type { Site } from "../../api/types.ts"
import { checkWpCore, compareVersions, wpTarget, type WpCoreCheckResult, type WpTargetMode } from "../../lib/wpCore.ts"
import {
  BULK_MAX_FAILURES,
  BULK_MAX_PARALLEL,
  clearBulk,
  startBulkCoreUpdate,
  stopBulk,
  useBulkRun,
  useWpCoreJobs,
  type BulkItem,
} from "../wpCoreJobs.tsx"

const CHECK_PARALLEL = 6

type Phase = "checking" | "plan" | "confirm"

// One row of the plan list: an update we'd run (toggleable) or a site we skip, and why.
type PlanRow =
  | { kind: "update"; item: Omit<BulkItem, "state" | "error"> }
  | { kind: "skip"; site: Site; reason: string; bad: boolean }

const MODE_LABEL: Record<WpTargetMode, string> = {
  line: "newest release in each site's line",
  newest: "newest release overall",
}

export function BulkWpUpdate() {
  const { bulkWpGroup: group, setBulkWpGroup, serverById, sshUser, noteWpVersion } = useStore()
  const run = useBulkRun()
  const coreJobs = useWpCoreJobs()
  const { height } = useTerminalDimensions()

  const [phase, setPhase] = useState<Phase>("checking")
  const [results, setResults] = useState<Map<number, WpCoreCheckResult>>(new Map())
  const [mode, setMode] = useState<WpTargetMode>("line")
  const [excluded, setExcluded] = useState<Set<number>>(new Set())
  const [index, setIndex] = useState(0)

  const sites = group?.sites ?? []

  // Live-check every site, CHECK_PARALLEL at a time. Skipped entirely while a
  // bulk run exists — then this overlay just shows that run.
  useEffect(() => {
    if (!group || run) return
    let live = true
    const queue = [...group.sites]
    const worker = async () => {
      for (let site = queue.shift(); site && live; site = queue.shift()) {
        const server = serverById(site.server_id)
        const res: WpCoreCheckResult = server ? await checkWpCore(server, site, sshUser) : { ok: false, target: "", error: "Server not loaded." }
        if (!live) return
        // A fresh live read — correct the row's cached version while we're here.
        if (res.ok) noteWpVersion(site, res.status.current)
        setResults((prev) => new Map(prev).set(site.id, res))
      }
    }
    void Promise.all(Array.from({ length: Math.min(CHECK_PARALLEL, queue.length) }, worker)).then(() => {
      if (live) setPhase("plan")
    })
    return () => {
      live = false
    }
    // Once per open: the group is a snapshot, and a refresh must not restart the check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, run === null])

  // Build the plan for the current target mode. Standard WP sites sort first so
  // the canary (the first included row) is a plain install when there is one.
  const rows = useMemo<PlanRow[]>(() => {
    const updates: PlanRow[] = []
    const skips: PlanRow[] = []
    for (const site of sites) {
      const res = results.get(site.id)
      const server = serverById(site.server_id)
      if (!res || !server) continue
      if (!res.ok) {
        skips.push({ kind: "skip", site, reason: `couldn't check: ${res.error}`, bad: true })
        continue
      }
      if (coreJobs.get(site.id)?.result === null) {
        skips.push({ kind: "skip", site, reason: "already updating", bad: false })
        continue
      }
      const to = wpTarget(res.status.current, res.status.offers, mode)
      if (!to) {
        const newer = res.status.offers.length > 0
        skips.push({ kind: "skip", site, reason: `${res.status.current} — ${newer ? "newest in its line" : "up to date"}`, bad: false })
        continue
      }
      updates.push({
        kind: "update",
        item: { site, server, from: res.status.current, to, multisite: res.status.multisite, composer: res.status.composer !== null },
      })
    }
    const key = (r: PlanRow) => (r.kind === "update" ? `${r.item.composer ? 1 : 0}${r.item.site.domain}` : r.site.domain)
    updates.sort((a, b) => key(a).localeCompare(key(b)))
    skips.sort((a, b) => key(a).localeCompare(key(b)))
    return [...updates, ...skips]
  }, [sites, results, mode, coreJobs, serverById])

  const included = rows.flatMap((r) => (r.kind === "update" && !excluded.has(r.item.site.id) ? [r.item] : []))
  const canaryId = included[0]?.site.id
  const composerCount = included.filter((i) => i.composer).length
  const updateCount = rows.filter((r) => r.kind === "update").length
  const skipCount = rows.length - updateCount
  const failedChecks = rows.filter((r) => r.kind === "skip" && r.bad).length
  const targets = [...new Set(included.map((i) => i.to))].sort(compareVersions)

  const close = () => {
    if (run?.phase === "done") clearBulk() // the summary has been seen
    setBulkWpGroup(null)
  }

  // The run view has its own cursor over the run's items.
  const listLen = run ? run.items.length : rows.length

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()
    if (name === "up" || name === "k") return setIndex((i) => moveSelection(i, -1, listLen))
    if (name === "down" || name === "j") return setIndex((i) => moveSelection(i, 1, listLen))

    if (run) {
      if (name === "x" && run.phase !== "done") stopBulk()
      return
    }
    if (phase === "plan") {
      if (name === "m") {
        setMode((m) => (m === "line" ? "newest" : "line"))
        setIndex(0)
        return
      }
      if (name === "space") {
        const r = rows[index]
        if (r?.kind !== "update") return
        setExcluded((prev) => {
          const next = new Set(prev)
          if (next.has(r.item.site.id)) next.delete(r.item.site.id)
          else next.add(r.item.site.id)
          return next
        })
        return
      }
      if ((name === "return" || name === "right" || name === "l") && included.length > 0) setPhase("confirm")
      return
    }
    if (phase === "confirm") {
      if (name === "y" && group) {
        startBulkCoreUpdate(group.title, included, sshUser, noteWpVersion)
        setIndex(0)
      } else if (name === "left" || name === "h") setPhase("plan")
    }
  })

  if (!group) return null
  const viewport = Math.max(4, height - 14)

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="⬆ Update WordPress  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={run ? run.title : group.title} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={`${run ? run.items.length : sites.length} sites`} fg={theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      {run ? renderRun() : phase === "checking" ? renderChecking() : phase === "plan" ? renderPlan() : renderConfirm()}

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderChecking() {
    return (
      <Centered>
        <box style={{ flexDirection: "row" }}>
          <Spinner />
          <text content={`  Checking WordPress on each site over SSH… ${results.size} of ${sites.length}`} fg={theme.textDim} />
        </box>
      </Centered>
    )
  }

  function renderPlan() {
    return (
      <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
        <Panel title=" Plan " active flexGrow={1}>
          <box style={{ flexGrow: 1, flexDirection: "column" }}>
            <box style={{ flexDirection: "row", height: 1 }}>
              <text content="Target: " fg={theme.textDim} style={{ flexShrink: 0 }} />
              <text content={MODE_LABEL[mode]} fg={theme.good} wrapMode="none" style={{ flexShrink: 0 }} />
              <text content={`   (m → ${MODE_LABEL[mode === "line" ? "newest" : "line"]})`} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
            </box>
            <text
              content={`${included.length} to update${excluded.size ? ` (${updateCount - included.length} left out)` : ""} · ${skipCount} skipped${failedChecks ? ` (${failedChecks} couldn't be checked)` : ""}`}
              fg={theme.text}
              wrapMode="none"
            />
            {composerCount ? (
              <text
                content={`${composerCount} Bedrock/Radicle ${composerCount === 1 ? "site" : "sites"} (⚙): composer.lock still pins the old version — the next composer install reverts it.`}
                fg={theme.warn}
                wrapMode="none"
              />
            ) : null}
            <box style={{ height: 1 }} />
            <box style={{ flexGrow: 1, flexDirection: "column" }}>
              <List
                items={rows}
                selectedIndex={index}
                viewportRows={viewport}
                focused
                keyFor={(r) => (r.kind === "update" ? r.item.site.id : r.site.id)}
                emptyText="No sites in this group"
                renderRow={(r, selected) => {
                  const fg = (c: string) => (selected ? theme.text : c)
                  if (r.kind === "skip") {
                    return (
                      <>
                        <text content="    " style={{ flexShrink: 0 }} />
                        <text content={truncate(r.site.domain, 44)} fg={fg(theme.textFaint)} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                        <text content={truncate(r.reason, 60)} fg={fg(r.bad ? theme.bad : theme.textFaint)} wrapMode="none" style={{ flexShrink: 0, marginLeft: 1 }} />
                      </>
                    )
                  }
                  const it = r.item
                  const on = !excluded.has(it.site.id)
                  return (
                    <>
                      <text content={on ? "[x] " : "[ ] "} fg={fg(on ? theme.good : theme.textFaint)} style={{ flexShrink: 0 }} />
                      <text content={truncate(it.site.domain, 44)} fg={fg(on ? theme.textDim : theme.textFaint)} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                      {it.site.id === canaryId ? <text content="canary " fg={fg(theme.brand)} style={{ flexShrink: 0 }} /> : null}
                      <text content={it.composer ? "⚙ " : "  "} fg={fg(theme.warn)} style={{ flexShrink: 0 }} />
                      <text content={`${it.from} → ${it.to}`.padStart(17)} fg={fg(on ? theme.good : theme.textFaint)} wrapMode="none" style={{ flexShrink: 0 }} />
                    </>
                  )
                }}
              />
            </box>
          </box>
        </Panel>
      </box>
    )
  }

  function renderConfirm() {
    const canary = included[0]
    return (
      <Centered>
        <Panel title=" Confirm bulk update " active>
          <box style={{ flexDirection: "column", width: 76, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`Update ${included.length} ${included.length === 1 ? "site" : "sites"} to the ${MODE_LABEL[mode]}`} fg={theme.text} wrapMode="none" />
            <text content={`(${targets.map((t) => `WordPress ${t}`).join(", ")})`} fg={theme.good} wrapMode="none" />
            <box style={{ height: 1 }} />
            <box style={{ flexDirection: "row" }}>
              <text content="Canary: " fg={theme.textDim} />
              <text content={truncate(canary?.site.domain ?? "", 44)} fg={theme.accent} wrapMode="none" />
              <text content=" goes first, alone." fg={theme.textDim} wrapMode="none" />
            </box>
            <text content="If it fails, no other site is touched." fg={theme.textDim} wrapMode="none" />
            <text
              content={`Then up to ${BULK_MAX_PARALLEL} at a time, one per server. Stops after ${BULK_MAX_FAILURES} failures.`}
              fg={theme.textDim}
              wrapMode="none"
            />
            <text content="Each site: wp core update, then the database upgrade." fg={theme.textDim} wrapMode="none" />
            {mode === "newest" && included.some((i) => i.from.split(".").slice(0, 2).join(".") !== i.to.split(".").slice(0, 2).join(".")) ? (
              <text content="Includes major updates — test plugins and themes against them." fg={theme.warn} wrapMode="none" />
            ) : null}
            {composerCount ? (
              <text
                content={`${composerCount} Bedrock/Radicle: composer.lock still pins the old version until you composer update.`}
                fg={theme.warn}
                wrapMode="none"
              />
            ) : null}
            <box style={{ height: 1 }} />
            <text content="Press y to start · ← to go back · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      </Centered>
    )
  }

  function renderRun() {
    const r = run!
    const count = (s: BulkItem["state"]) => r.items.filter((i) => i.state === s).length
    const done = count("done")
    const failed = count("failed")
    const headline =
      r.phase === "canary"
        ? `Canary: updating ${r.items[0].site.domain} first…`
        : r.phase === "done"
          ? `Finished — ${done} of ${r.items.length} updated${failed ? `, ${failed} failed` : ""}${count("notRun") ? `, ${count("notRun")} not run` : ""}.`
          : `${r.phase === "stopping" ? "Stopping — " : "Updating — "}${done} of ${r.items.length} done${failed ? `, ${failed} failed` : ""}, ${count("running")} running.`
    const selected = r.items[Math.min(index, r.items.length - 1)]
    return (
      <box style={{ flexGrow: 1, flexDirection: "column", padding: 1 }}>
        <Panel title={r.phase === "done" ? " Summary " : " Progress "} active flexGrow={1}>
          <box style={{ flexGrow: 1, flexDirection: "column" }}>
            <box style={{ flexDirection: "row", height: 1 }}>
              {r.phase !== "done" ? <Spinner /> : null}
              <text content={(r.phase !== "done" ? " " : "") + headline} fg={failed ? theme.warn : theme.text} wrapMode="none" />
            </box>
            {r.stopReason ? <text content={r.stopReason} fg={theme.warn} wrapMode="none" /> : null}
            {group && r.title !== group.title ? (
              <text content={`You opened ${group.title} — one bulk update runs at a time, so it can start once this one finishes.`} fg={theme.warn} wrapMode="none" />
            ) : null}
            {r.phase !== "done" ? <text content="Esc keeps it running in the background." fg={theme.textFaint} wrapMode="none" /> : null}
            <box style={{ height: 1 }} />
            <box style={{ flexGrow: 1, flexDirection: "column" }}>
              <List
                items={r.items}
                selectedIndex={Math.min(index, r.items.length - 1)}
                viewportRows={viewport - 1}
                focused
                keyFor={(i) => i.site.id}
                emptyText=""
                renderRow={(it, sel, i) => {
                  const fg = (c: string) => (sel ? theme.text : c)
                  const icon = { queued: "·", running: "", done: "✓", failed: "✕", notRun: "–" }[it.state]
                  const iconFg = { queued: theme.textFaint, running: theme.brand, done: theme.good, failed: theme.bad, notRun: theme.textFaint }[it.state]
                  return (
                    <>
                      {it.state === "running" ? <Spinner color={fg(theme.brand)} interval={120} /> : <text content={icon} fg={fg(iconFg)} style={{ flexShrink: 0 }} />}
                      <text content=" " style={{ flexShrink: 0 }} />
                      <text content={truncate(it.site.domain, 44)} fg={fg(theme.textDim)} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />
                      {i === 0 ? <text content="canary " fg={fg(theme.brand)} style={{ flexShrink: 0 }} /> : null}
                      <text content={it.composer ? "⚙ " : "  "} fg={fg(theme.warn)} style={{ flexShrink: 0 }} />
                      <text content={`${it.from} → ${it.to}`.padStart(17)} fg={fg(it.state === "done" ? theme.good : theme.textFaint)} wrapMode="none" style={{ flexShrink: 0 }} />
                    </>
                  )
                }}
              />
            </box>
            {/* The selected row's failure, in full — the list row has no room for it. */}
            {selected?.state === "failed" ? <text content={`✕ ${selected.site.domain}: ${selected.error ?? "failed"}`} fg={theme.bad} /> : null}
          </box>
        </Panel>
      </box>
    )
  }

  function hints() {
    if (run) {
      return run.phase === "done"
        ? [
            { key: "↑↓/jk", label: "site" },
            { key: "esc", label: "close" },
          ]
        : [
            { key: "↑↓/jk", label: "site" },
            { key: "x", label: "stop after current" },
            { key: "esc", label: "run in background" },
          ]
    }
    if (phase === "plan") {
      return [
        { key: "↑↓/jk", label: "site" },
        { key: "space", label: "include/leave out" },
        { key: "m", label: "switch target" },
        { key: "⏎", label: "review" },
        { key: "esc", label: "cancel" },
      ]
    }
    if (phase === "confirm") {
      return [
        { key: "y", label: "start" },
        { key: "←", label: "back" },
        { key: "esc", label: "cancel" },
      ]
    }
    return [{ key: "esc", label: "cancel" }]
  }
}

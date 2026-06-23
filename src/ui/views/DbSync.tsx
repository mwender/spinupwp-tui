// Production → local DB sync overlay.
//
// Opened with `p` on a linked WordPress site (Search). Pulls the production
// database into the local working copy: backs up local first, exports/downloads
// prod (read-only), imports it, rewrites URLs, and runs an optional post-import
// hook. DESTRUCTIVE on local — so the confirm screen says so plainly. The work
// runs in the store (`startDbSync`), so closing the modal (Esc/q) doesn't abandon
// it; the row keeps a spinner and reopening shows live progress.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate, middleTruncate } from "../../lib/format.ts"
import { Panel, Centered, DestPath, Steps, type StepRow } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { writeSampleHook, type DbSyncStage } from "../../lib/dbSync.ts"

// The pull's stages in run order — rendered as a building checklist. The hook
// row is included only when the plan found a bin/sync.d/post-import.sh.
const SYNC_STEPS: { stage: DbSyncStage; label: string }[] = [
  { stage: "local-backup", label: "Back up local database" },
  { stage: "export", label: "Export production database" },
  { stage: "download", label: "Download the dump" },
  { stage: "import", label: "Import into local" },
  { stage: "replace", label: "Rewrite production URLs → local" },
  { stage: "hook", label: "Run post-import hook" },
]

export function DbSync() {
  const { dbSyncSite: site, setDbSyncSite, serverById, planDbSyncFor, dbSyncs, startDbSync, clearDbSync, planMediaFallbackFor, setMediaFallbackSite } = useStore()

  const planResult = site ? planDbSyncFor(site) : null
  const progress = site ? dbSyncs.get(site.id) : undefined
  const [started, setStarted] = useState(false)
  // Result of scaffolding a sample post-import hook (s on the confirm screen).
  const [scaffold, setScaffold] = useState<{ ok: true; path: string } | { ok: false; error: string } | null>(null)

  const dp: "blocked" | "confirm" | "running" | "done" | "error" =
    planResult && !planResult.ok && !progress
      ? "blocked"
      : !started && !progress
        ? "confirm"
        : progress?.stage === "done"
          ? "done"
          : progress?.stage === "error"
            ? "error"
            : "running"

  const close = () => {
    if (site && (progress?.stage === "done" || progress?.stage === "error")) clearDbSync(site.id)
    setDbSyncSite(null)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()
    if (dp === "confirm") {
      if (name === "return" || name === "y") {
        if (site) {
          startDbSync(site)
          setStarted(true)
        }
        return
      }
      // s: scaffold a sample hook — only when none exists yet.
      if (name === "s" && plan && !plan.hookPath) {
        try {
          setScaffold({ ok: true, path: writeSampleHook(plan.localRoot) })
        } catch (e) {
          setScaffold({ ok: false, error: e instanceof Error ? e.message : "Couldn't write the sample hook." })
        }
      }
      return
    }
    if (dp === "error") {
      if (name === "r") {
        if (site) clearDbSync(site.id)
        setStarted(false)
      }
      return
    }
    if (dp === "done") {
      // m: hand off to the media-fallback overlay for the just-synced site.
      if (name === "m" && site) {
        close()
        setMediaFallbackSite(site)
      }
      return
    }
  })

  if (!site) return null
  const server = serverById(site.server_id)
  const plan = planResult && planResult.ok ? planResult.plan : null
  // Whether this site already has the production media-fallback plugin (shapes the
  // Done-screen nudge). Only meaningful on the done screen.
  const mfPlan = dp === "done" ? planMediaFallbackFor(site) : null
  const mediaFallbackEnabled = !!(mfPlan && mfPlan.ok && mfPlan.plan.enabled)

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
      <box
        style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}
      >
        <text content="⇣ Pull production → local  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 38)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content="overwrites local DB" fg={theme.warn} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  // The post-import-hook line(s) on the confirm screen. Three states: a fresh
  // scaffold result (wins, so the user sees their action land), an existing hook
  // (it'll run), or none — in which case we explain the extension point in
  // context and offer `s` to write an inert sample.
  function renderHookSection() {
    if (scaffold?.ok) {
      return (
        <>
          <box style={{ height: 1 }} />
          <box style={{ flexDirection: "row" }}>
            <text content="✓ " fg={theme.good} />
            <text content="wrote bin/sync.d/post-import.sh — edit it, then pull." fg={theme.text} wrapMode="none" />
          </box>
          <text content="  (it's inert until you uncomment a command)" fg={theme.textFaint} wrapMode="none" />
        </>
      )
    }
    if (scaffold && !scaffold.ok) {
      return (
        <>
          <box style={{ height: 1 }} />
          <text content={`✕ ${scaffold.error}`} fg={theme.bad} wrapMode="none" />
        </>
      )
    }
    if (plan?.hookPath) {
      return (
        <>
          <box style={{ height: 1 }} />
          <text content="↪ post-import hook will run (your per-project tweaks)" fg={theme.purple} wrapMode="none" />
        </>
      )
    }
    return (
      <>
        <box style={{ height: 1 }} />
        <text content="No post-import hook set up for this project." fg={theme.textFaint} wrapMode="none" />
        <text content="Spinup can run bin/sync.d/post-import.sh after each pull —" fg={theme.textFaint} wrapMode="none" />
        <text content="e.g. swap Elementor URLs, toggle dev-only plugins." fg={theme.textFaint} wrapMode="none" />
        <text content="  s  write a sample hook" fg={theme.textDim} wrapMode="none" />
      </>
    )
  }

  function renderBody() {
    if (dp === "blocked") {
      return (
        <Panel title=" Can't sync yet " active>
          <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
            <text content={planResult && !planResult.ok ? planResult.error : "Unavailable."} fg={theme.warn} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Esc to close" fg={theme.textFaint} />
          </box>
        </Panel>
      )
    }

    if (dp === "confirm") {
      return (
        <Panel title=" Pull production database to local " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="⚠ " fg={theme.warn} />
              <text content="This OVERWRITES your local database." fg={theme.text} wrapMode="none" />
            </box>
            <text content="  (your local DB is backed up first, just in case)" fg={theme.textFaint} wrapMode="none" />
            <box style={{ height: 1 }} />
            <box style={{ flexDirection: "row" }}>
              <text content="from " fg={theme.textFaint} />
              <text content={truncate(site!.domain, 30)} fg={theme.accent} wrapMode="none" />
              <text content=" on " fg={theme.textDim} />
              <text content={truncate(server?.name ?? "—", 22)} fg={theme.textDim} wrapMode="none" />
            </box>
            <text content="into" fg={theme.textFaint} />
            {plan ? <DestPath path={plan.localRoot} fileColor={theme.good} width={64} /> : null}
            <box style={{ height: 1 }} />
            <text content="rewrite URLs" fg={theme.textFaint} />
            <text content={`  ${plan ? middleTruncate(`${plan.remoteOrigin} → ${plan.localOrigin}`, 64) : "—"}`} fg={theme.textDim} wrapMode="none" />
            {renderHookSection()}
            {plan?.prefixWarning ? (
              <>
                <box style={{ height: 1 }} />
                <text content={`⚠ ${plan.prefixWarning}`} fg={theme.warn} wrapMode="none" />
              </>
            ) : null}
            <box style={{ height: 1 }} />
            <text content="Production is only read from — nothing there is modified." fg={theme.textFaint} wrapMode="none" />
            <text content="Press y / ⏎ to pull · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // running | done | error share one bordered checklist so the whole pull
    // reads as a building stack; the footer carries the live/result/error status.
    const steps = SYNC_STEPS.filter((s) => s.stage !== "hook" || !!plan?.hookPath)
    const order = steps.map((s) => s.stage)
    const curIdx = order.indexOf((progress?.stage ?? "local-backup") as DbSyncStage)
    const failedIdx = progress?.failedStage ? order.indexOf(progress.failedStage) : order.length - 1
    const rows: StepRow[] = steps.map(({ label }, i) => {
      const state: StepRow["state"] =
        dp === "done"
          ? "done"
          : dp === "error"
            ? i < failedIdx
              ? "done"
              : i === failedIdx
                ? "failed"
                : "pending"
            : i < curIdx
              ? "done"
              : i === curIdx
                ? "active"
                : "pending"
      return { label, state }
    })

    return (
      <Panel title=" Pull production → local " active>
        <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
          <Steps rows={rows} />
          <box style={{ height: 1 }} />
          {dp === "done" ? (
            <>
              <box style={{ flexDirection: "row" }}>
                <text content="✓ " fg={theme.good} />
                <text content="Done — local now mirrors production." fg={theme.text} wrapMode="none" />
              </box>
              <box style={{ height: 1 }} />
              <text content="prod dump saved" fg={theme.textFaint} />
              {progress?.downloadPath ? <DestPath path={progress.downloadPath} fileColor={theme.accent} width={62} /> : null}
              <text content="local DB backup" fg={theme.textFaint} />
              {progress?.localBackupPath ? <DestPath path={progress.localBackupPath} fileColor={theme.textDim} width={62} /> : null}
              <box style={{ height: 1 }} />
              {mediaFallbackEnabled ? (
                <text content="✓ Missing images load from production (media fallback on)." fg={theme.textFaint} wrapMode="none" />
              ) : (
                <text content="Images 404ing locally? Press m to serve them from production." fg={theme.purple} wrapMode="none" />
              )}
              <text content="Esc to close" fg={theme.textFaint} />
            </>
          ) : dp === "error" ? (
            <>
              <text content={`✕ ${progress?.error ?? "Something went wrong."}`} fg={theme.bad} />
              <box style={{ height: 1 }} />
              <text content="Your local DB backup is in sql/ if you need to restore." fg={theme.textFaint} wrapMode="none" />
              <text content="Press r to try again · Esc to close" fg={theme.textFaint} wrapMode="none" />
            </>
          ) : (
            <text content="You can press Esc — it keeps running in the background." fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </Panel>
    )
  }

  function hints() {
    switch (dp) {
      case "confirm":
        return [
          { key: "y/⏎", label: "pull" },
          ...(plan && !plan.hookPath ? [{ key: "s", label: "sample hook" }] : []),
          { key: "esc", label: "cancel" },
        ]
      case "error":
        return [
          { key: "r", label: "retry" },
          { key: "esc", label: "close" },
        ]
      case "done":
        return [
          ...(mediaFallbackEnabled ? [] : [{ key: "m", label: "media fallback" }]),
          { key: "esc", label: "close" },
        ]
      default:
        return [{ key: "esc", label: "close" }]
    }
  }
}

// Clone a brand-new local working copy from production — the guided
// alternative to `L`'s manual "enter a path" form, offered when a site has no
// local link yet. Opened from LocalLink.tsx's choose screen.
//
// Gets the code down (git clone, or an rsync pull over SSH excluding uploads/
// for non-git sites), runs `composer install` for Bedrock/Radicle, then links
// the result exactly like the manual form would. It deliberately stops there —
// the local database and webserver config are NOT touched here. On success it
// hands off to the existing dbSync (`p`) flow unchanged (which itself gates on
// `localSync` being enabled), then that flow's own done screen already nudges
// into mediaFallback (`m`). Three existing, already-reviewed screens chained
// by keypresses, not one new mega state machine.

import { useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate, middleTruncate } from "../../lib/format.ts"
import { Panel, Centered, DestPath, Steps, type StepRow } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import type { LocalSetupStage } from "../../lib/localSetup.ts"

const SETUP_STEPS: { stage: LocalSetupStage; label: string }[] = [
  { stage: "fetch", label: "Get the code (clone / pull)" },
  { stage: "build", label: "composer install" },
]

export function LocalSetupOverlay() {
  const { localSetupSite: site, setLocalSetupSite, serverById, planLocalSetupFor, localSetups, startLocalSetup, clearLocalSetup, localSync, setEnableLocalSyncSite, setDbSyncSite } = useStore()

  const progress = site ? localSetups.get(site.id) : undefined
  const [path, setPath] = useState("")
  const [url, setUrl] = useState("")
  const [field, setField] = useState<"path" | "url">("path")
  const [formError, setFormError] = useState<string | null>(null)

  const dp: "form" | "running" | "done" | "error" =
    !progress ? "form" : progress.stage === "done" ? "done" : progress.stage === "error" ? "error" : "running"

  const close = () => {
    if (site && (progress?.stage === "done" || progress?.stage === "error")) clearLocalSetup(site.id)
    setLocalSetupSite(null)
  }

  const submit = () => {
    if (!site) return
    const res = planLocalSetupFor(site, path, url)
    if (!res.ok) {
      setFormError(res.error)
      return
    }
    setFormError(null)
    startLocalSetup(site, path, url)
  }

  const pullDb = () => {
    if (!site) return
    close()
    if (!localSync) setEnableLocalSyncSite(site)
    else setDbSyncSite(site)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape" || name === "q") return close()

    if (dp === "form") {
      if (name === "up") return setField("path")
      if (name === "down") return setField("url")
      return
    }
    if (dp === "error") {
      if (name === "r" && site) {
        clearLocalSetup(site.id)
        setFormError(null)
      }
      return
    }
    if (dp === "done") {
      if (name === "return" || name === "p") return pullDb()
      return
    }
  })

  if (!site) return null
  const server = serverById(site.server_id)
  const isGit = !!site.git?.repo

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="⇩ Clone fullsite (DB + files) from production  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 38)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
      </box>

      <Centered>{renderBody()}</Centered>

      <StatusBar hints={hints()} showGlobal={false} />
    </box>
  )

  function renderBody() {
    if (dp === "form") {
      return (
        <Panel title=" Clone from production " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <box style={{ flexDirection: "row" }}>
              <text content="from " fg={theme.textFaint} />
              <text content={truncate(site!.domain, 30)} fg={theme.accent} wrapMode="none" />
              <text content=" on " fg={theme.textDim} />
              <text content={truncate(server?.name ?? "—", 22)} fg={theme.textDim} wrapMode="none" />
            </box>
            <text content={isGit ? "source: git clone (this site's repo)" : "source: file pull over SSH (excludes uploads/)"} fg={theme.textFaint} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Local path for the new working copy" fg={field === "path" ? theme.accent : theme.textDim} />
            <input
              focused={field === "path"}
              value={path}
              placeholder={`~/code/${site!.domain}`}
              onInput={setPath}
              onSubmit={() => setField("url")}
              style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
            />
            <box style={{ height: 1 }} />
            <text content="Local URL (optional) — Valet, Cove, LocalWP, Herd, DDEV…" fg={field === "url" ? theme.accent : theme.textDim} />
            <input
              focused={field === "url"}
              value={url}
              placeholder="https://example.test"
              onInput={setUrl}
              onSubmit={submit}
              style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
            />
            {formError ? (
              <>
                <box style={{ height: 1 }} />
                <text content={`✕ ${formError}`} fg={theme.bad} wrapMode="none" />
              </>
            ) : null}
            <box style={{ height: 1 }} />
            <text content="This only pulls code — your local DB/webserver aren't touched." fg={theme.textFaint} wrapMode="none" />
            <text content="↑↓ switch field · Enter on the URL starts · Esc cancels" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }

    // "build" (composer install) only applies to Bedrock/Radicle — unknown
    // until the fetch stage finishes, so it stays out of the list entirely
    // (like DbSync's optional hook row) until we actually know, rather than
    // rendering a row that never ran as if it had.
    const buildApplies =
      progress?.stage === "build" ||
      (progress?.stage === "done" && !!progress.ranComposer) ||
      (progress?.stage === "error" && progress.failedStage === "build")
    const steps = SETUP_STEPS.filter((s) => s.stage !== "build" || buildApplies)
    const order = steps.map((s) => s.stage)
    const curIdx = order.indexOf((progress?.stage ?? "fetch") as LocalSetupStage)
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
      <Panel title=" Cloning from production " active>
        <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
          <Steps rows={rows} />
          <box style={{ height: 1 }} />
          {dp === "done" ? (
            <>
              <box style={{ flexDirection: "row" }}>
                <text content="✓ " fg={theme.good} />
                <text content="Files are down and linked." fg={theme.text} wrapMode="none" />
              </box>
              <box style={{ height: 1 }} />
              <DestPath path={middleTruncate(progress?.destPath ?? "", 62)} fileColor={theme.good} width={62} />
              {progress?.ranComposer ? <text content="composer install ran" fg={theme.textFaint} wrapMode="none" /> : null}
              <box style={{ height: 1 }} />
              <text content="Next: create a local database and point your local tool at it." fg={theme.textFaint} wrapMode="none" />
              {/* The file pull copies the site's real wp-config.php, production
                  DB credentials and all. Nothing local can reach production's
                  database through them (its DB_HOST is localhost), but local
                  wp-cli authenticates as the production user, so the DB pull
                  below is denied until they're localized. Say so here rather
                  than letting it surface as a bare "Access denied" later. */}
              {isGit ? null : (
                <>
                  <text content="wp-config.php came down with production's DB credentials —" fg={theme.warn} wrapMode="none" />
                  <text content="update DB_NAME / DB_USER / DB_PASSWORD / DB_HOST to match," fg={theme.warn} wrapMode="none" />
                  <text content="or the DB pull is denied as production's user." fg={theme.warn} wrapMode="none" />
                </>
              )}
              <text content="Press ⏎ / p to pull production's database now, once that's ready." fg={theme.purple} wrapMode="none" />
              <text content="Esc to finish here" fg={theme.textFaint} wrapMode="none" />
            </>
          ) : dp === "error" ? (
            <>
              <text content={`✕ ${progress?.error ?? "Something went wrong."}`} fg={theme.bad} />
              <box style={{ height: 1 }} />
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
      case "form":
        return [
          { key: "↑↓", label: "field" },
          { key: "⏎", label: "start" },
          { key: "esc", label: "cancel" },
        ]
      case "error":
        return [
          { key: "r", label: "retry" },
          { key: "esc", label: "close" },
        ]
      case "done":
        return [
          { key: "⏎/p", label: "pull DB" },
          { key: "esc", label: "close" },
        ]
      default:
        return [{ key: "esc", label: "close" }]
    }
  }
}

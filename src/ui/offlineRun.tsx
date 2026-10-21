// Shared by the two places that take sites offline: the server actions menu
// (`a`, the whole server) and the site overlay (`O`, one site). The work itself
// is lib/offline.ts; this is the progress state and panel around it.
//
// It runs in the overlay rather than the store: what it changes is recorded on
// disk as it goes, so closing the overlay mid-run loses only the progress
// lines, never the ability to undo it.

import { useState } from "react"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { theme } from "../lib/theme.ts"
import { isDevMode } from "../dev/devMode.ts"
import { Panel, Spinner } from "./components.tsx"
import { toast } from "./toast.ts"

// Dev Mode's fake servers must never land in the real account's offline record.
export const offlineDir = () => (isDevMode() ? join(tmpdir(), "spinuptui-dev-offline") : undefined)

export interface OfflineRun {
  mode: "offline" | "online"
  lines: string[]
  finished: boolean
  summary?: string
  failed?: boolean
}

export type OfflineJob = (onProgress: (line: string) => void) => Promise<{ summary: string; failed: boolean }>

// `label` prefixes the completion toast (a server or site name), since the
// overlay may be closed by the time it finishes.
export function useOfflineRun(refresh: () => Promise<void>) {
  const [run, setRun] = useState<OfflineRun | null>(null)
  const start = (mode: OfflineRun["mode"], label: string, job: OfflineJob) => {
    const push = (line: string) => setRun((r) => (r ? { ...r, lines: [...r.lines, line] } : r))
    setRun({ mode, lines: [], finished: false })
    void (async () => {
      let summary: string
      let failed: boolean
      try {
        ;({ summary, failed } = await job(push))
      } catch (err) {
        summary = (err as Error).message
        failed = true
      }
      setRun((r) => (r ? { ...r, finished: true, summary, failed } : r))
      if (failed) toast.error(`${label}: ${summary}`)
      else toast.success(`${label}: ${summary}`)
      await refresh()
    })()
  }
  return { run, start }
}

export function OfflineProgress({ run, plural }: { run: OfflineRun; plural: boolean }) {
  const shown = run.lines.slice(-10)
  const what = plural ? "sites" : "site"
  return (
    <Panel title={run.mode === "offline" ? ` Taking ${what} offline ` : ` Bringing ${what} back online `} active>
      <box style={{ flexDirection: "column", width: 66, paddingTop: 1, paddingBottom: 1 }}>
        {shown.map((l, i) => (
          <text key={i} content={l} fg={l.includes("✕") ? theme.bad : l.includes("✓") ? theme.good : theme.textDim} wrapMode="none" />
        ))}
        <box style={{ height: 1 }} />
        {run.finished ? (
          <text content={`${run.failed ? "✕" : "✓"} ${run.summary}`} fg={run.failed ? theme.bad : theme.good} />
        ) : (
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content={plural ? "  Working — SpinupWP runs a server's sites one at a time." : "  Working — usually a few seconds."} fg={theme.textDim} wrapMode="none" />
          </box>
        )}
        <box style={{ height: 1 }} />
        <text
          content={run.finished ? "Esc to close" : "Esc to close — it keeps running, and each change is recorded."}
          fg={theme.textFaint}
          wrapMode="none"
        />
      </box>
    </Panel>
  )
}

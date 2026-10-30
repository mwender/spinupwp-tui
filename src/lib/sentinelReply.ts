// The lines /incidents and `sentinel list` share.

import type { BeaconButton } from "../modules/contract.ts"
import { diagnoseButton } from "./sentinelIncidents.ts"
import { isWaiting, type Incident } from "./sentinelState.ts"

export interface WaitingRow {
  line: string
  button?: BeaconButton
}

const WORDS: Record<string, string> = {
  queued: "queued",
  diagnosing: "being diagnosed",
  waiting_agent: "waiting on the agent's login",
  blocked: "blocked",
  failed: "failed",
  recurrence: "recurring, not re-diagnosed",
  reported: "reported",
  shadow: "seen in shadow mode",
}

export function describeIncident(i: Incident): string {
  const domains = [...new Set(i.events.map((e) => e.domain))].join(", ")
  return `${domains} (${[...new Set(i.events.map((e) => e.kind))].join(", ")}): ${WORDS[i.state] ?? i.state}${i.why ? `: ${i.why}` : ""}${i.closedAt ? "" : i.down.length ? ", still down" : ""}`
}

export function waitingRows(incidents: Incident[]): WaitingRow[] {
  const rows: WaitingRow[] = []
  for (const i of incidents) {
    if (!isWaiting(i) && i.closedAt) continue
    const button = i.state === "recurrence" ? diagnoseButton(i.id, `Diagnose ${i.events[0]!.domain}`) : i.state === "blocked" || i.state === "failed" ? diagnoseButton(i.id, `Run ${i.events[0]!.domain} again`) : undefined
    rows.push({ line: describeIncident(i), ...(button ? { button } : {}) })
  }
  return rows
}

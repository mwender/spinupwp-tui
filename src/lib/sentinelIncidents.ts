// What a tick decides, with no I/O: which events are new, how they group into
// incidents, what's a recurrence, and what to page. The tick feeds it state and
// carries out what it returns (docs/2026-10-30_sentinel-spec.md, "Incidents").

import type { IncidentEvent as KumaEvent } from "./cliIncidents.ts"
import { seenKey, SEEN_KEEP_DAYS, type Fleet, type Incident, type Seen } from "./sentinelState.ts"
import type { BeaconButton } from "../modules/contract.ts"

const HOUR = 3_600_000
export const CLOSE_QUIET_MS = 30 * 60_000
const CLOSE_ANYWAY_MS = 7 * 24 * HOUR
const LOUD_RECURRENCE = 3

export interface Page {
  text: string
  silent: boolean
  buttons?: BeaconButton[][]
}

// A Kuma time ("2026-10-30 13:34:05.123") is UTC with no zone marker.
export const eventMs = (time: string) => Date.parse(`${time.replace(" ", "T").slice(0, 23)}Z`)

// The events not handled yet. A seen-set rather than a timestamp: a monitor whose
// history failed to read last time can still deliver an event older than one
// already handled, and two events can share a timestamp.
export function newEvents(events: KumaEvent[], seen: Seen): KumaEvent[] {
  return events.filter((e) => !seen[seenKey(e)])
}

export function markSeen(seen: Seen, events: KumaEvent[], now: Date): Seen {
  const out = { ...seen }
  for (const e of events) out[seenKey(e)] = e.time
  const cutoff = now.getTime() - SEEN_KEEP_DAYS * 24 * HOUR
  for (const [k, t] of Object.entries(out)) if (eventMs(t) < cutoff) delete out[k]
  return out
}

// How far back to read: from the last tick that read every monitor.
export function windowHours(lastCleanAt: string | undefined, now: Date): number {
  if (!lastCleanAt) return 1
  const hours = Math.ceil((now.getTime() - Date.parse(lastCleanAt)) / HOUR) + 1
  return Math.min(Math.max(hours, 1), 168)
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

export interface ApplyInput {
  incidents: Incident[]
  events: KumaEvent[]
  fleet: Fleet
  now: Date
  recurrenceHours: number
  hasAgent: boolean
  shadow: boolean
  kumaAlerted: Set<number>
}

export interface ApplyOutput {
  changed: Incident[]
  created: Incident[]
  pages: Page[]
  unknownDomains: string[]
}

function covering(all: Incident[], e: KumaEvent, sinceMs: number): Incident | null {
  const live = new Set(["reported", "queued", "diagnosing", "waiting_agent", "shadow"])
  for (const i of [...all].reverse()) {
    if (!live.has(i.state)) continue
    if (Date.parse(i.reportedAt ?? i.createdAt) < sinceMs) continue
    if (i.events.some((x) => x.domain === e.domain && x.kind === e.kind)) return i
  }
  return null
}

const domainsOf = (i: Incident) => [...new Set(i.events.map((e) => e.domain))]
const kindsOf = (i: Incident) => [...new Set(i.events.map((e) => e.kind))]

export function diagnoseButton(id: string, text = "Diagnose anyway"): BeaconButton {
  return { text, action: "sentinel.diagnose", payload: { id } }
}

function newIncidentPage(i: Incident, hasAgent: boolean, kumaAlerted: Set<number>): Page {
  const where = i.server ? ` on ${i.server}` : ""
  const next = hasAgent ? "diagnosing" : "writing it up (no agent configured)"
  return {
    text: `🔴 ${domainsOf(i).join(", ")} down (${kindsOf(i).join(", ")})${where}: ${next}.`,
    // Kuma already made a sound for this; Sentinel's job is the "why" that follows.
    silent: i.events.every((e) => kumaAlerted.has(e.monitorId)),
  }
}

function recurrencePage(i: Incident, earlier: Incident, count: number): Page {
  const first = i.events[0]!
  return {
    text: `🔁 ${first.domain} ${first.kind} again${count > 1 ? ` (${count} in 24h)` : ""}. Covered by ${earlier.reportPath ?? earlier.id}, so no new diagnosis.`,
    silent: count < LOUD_RECURRENCE,
    buttons: [[diagnoseButton(i.id)]],
  }
}

// Applies new events to the incidents. A down event joins its server's open
// incident, or starts one, unless a recent report already covers it. An up event
// clears its monitor.
export function applyEvents(input: ApplyInput): ApplyOutput {
  const { fleet, now, recurrenceHours, hasAgent, shadow, kumaAlerted } = input
  const all = [...input.incidents]
  const changed = new Map<string, Incident>()
  const created: Incident[] = []
  const fresh = new Set<string>()
  const unknownDomains = new Set<string>()
  const pages: Page[] = []
  const nowIso = now.toISOString()

  for (const e of [...input.events].sort((a, b) => a.time.localeCompare(b.time))) {
    if (e.status === "up") {
      for (const i of all) {
        if (!i.closedAt && i.down.includes(e.monitorId)) {
          i.down = i.down.filter((m) => m !== e.monitorId)
          changed.set(i.id, i)
        }
      }
      continue
    }
    if (e.status !== "down") continue
    const entry = fleet.domains[e.domain]
    if (!entry) unknownDomains.add(e.domain)
    const key = entry?.server ?? e.domain
    const event = { domain: e.domain, kind: e.kind, time: e.time, message: e.message, monitorId: e.monitorId }
    const open = all.find((i) => !i.closedAt && i.key === key)
    if (open) {
      const known = open.events.some((x) => x.domain === e.domain)
      open.events.push(event)
      if (!open.down.includes(e.monitorId)) open.down.push(e.monitorId)
      open.lastDownAt = nowIso
      changed.set(open.id, open)
      if (!known && !fresh.has(open.id)) pages.push({ text: `➕ ${e.domain} (${e.kind}) joined the incident on ${key}.`, silent: true })
      continue
    }
    const earlier = covering(all, e, now.getTime() - recurrenceHours * HOUR)
    const base = `${stamp(now)}-${slug(key)}`
    let id = base
    for (let n = 2; all.some((i) => i.id === id); n++) id = `${base}-${n}`
    const incident: Incident = {
      id,
      key,
      server: entry?.server ?? null,
      state: earlier ? "recurrence" : shadow ? "shadow" : "queued",
      createdAt: nowIso,
      events: [event],
      down: [e.monitorId],
      lastDownAt: nowIso,
      attempts: 0,
      ...(earlier ? { refersTo: earlier.id } : {}),
    }
    all.push(incident)
    created.push(incident)
    changed.set(id, incident)
    fresh.add(id)
  }

  for (const i of created) {
    if (i.state === "recurrence") {
      const earlier = all.find((x) => x.id === i.refersTo)!
      const domain = i.events[0]!.domain
      const count = all.filter((x) => x.state === "recurrence" && Date.parse(x.createdAt) > now.getTime() - 24 * HOUR && x.events.some((y) => y.domain === domain)).length
      pages.push(recurrencePage(i, earlier, count))
    } else {
      pages.push(newIncidentPage(i, hasAgent, kumaAlerted))
    }
  }
  return { changed: [...changed.values()], created, pages, unknownDomains: [...unknownDomains] }
}

// Closes what's over: every monitor back and quiet for 30 minutes. A monitor that
// never reports back (deleted in Kuma, say) can't hold an incident open forever.
export function closeIncidents(incidents: Incident[], now: Date): Incident[] {
  const out: Incident[] = []
  for (const i of incidents) {
    if (i.closedAt) continue
    const quiet = now.getTime() - Date.parse(i.lastDownAt)
    if ((i.down.length === 0 && quiet >= CLOSE_QUIET_MS) || quiet >= CLOSE_ANYWAY_MS) {
      i.closedAt = now.toISOString()
      out.push(i)
    }
  }
  return out
}

// How many diagnoses have started today, for the daily cap.
export function startedToday(incidents: Incident[], now: Date): number {
  const day = now.toLocaleDateString("en-CA")
  return incidents.filter((i) => i.startedAt && new Date(i.startedAt).toLocaleDateString("en-CA") === day).length
}

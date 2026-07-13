// `spinuptui incidents <domain>` / `spinuptui incidents --all` — surfaces
// Uptime Kuma's down/up incident history for the fleet SpinupTUI itself
// manages monitoring for, for external tooling (e.g. an incident-diagnostics
// agent polling on its own schedule). Scoped to config.kumaMonitors, not
// Kuma's full live monitor list — a monitor added by hand in Kuma with no
// corresponding SpinupWP site would have nowhere actionable for a caller to
// go, so it's deliberately excluded.

import type { AppConfig, KumaMonitorRef } from "../config.ts"
import { withKuma, KumaError, type KumaBeat } from "./uptimeKuma.ts"

export type IncidentKind = "health" | "push" | "redis" | "fingerprint" | "fatal" | "bypass"
export type IncidentStatus = "down" | "up" | "pending" | "maintenance"

export interface IncidentEvent {
  domain: string
  kind: IncidentKind
  status: IncidentStatus
  time: string
  message: string
}

export type IncidentsResult =
  | { ok: true; windowHours: number; events: IncidentEvent[] }
  | { ok: false; reason: "kuma_not_configured" | "no_monitors_registered" | "kuma_error"; message: string }

const STATUS_LABEL: Record<number, IncidentStatus> = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" }

const KIND_FIELDS: Array<[keyof KumaMonitorRef, IncidentKind]> = [
  ["healthId", "health"],
  ["pushId", "push"],
  ["redisId", "redis"],
  ["fingerprintId", "fingerprint"],
  ["fatalId", "fatal"],
  ["bypassId", "bypass"],
]

interface Target {
  domain: string
  kind: IncidentKind
  id: number
}

export async function resolveIncidents(
  cfg: AppConfig,
  opts: { domain?: string; hours: number },
): Promise<IncidentsResult> {
  if (!cfg.uptimeKuma) {
    return {
      ok: false,
      reason: "kuma_not_configured",
      message: "No Uptime Kuma connection configured in SpinupTUI.",
    }
  }

  const domains = opts.domain ? [opts.domain] : Object.keys(cfg.kumaMonitors)
  const targets: Target[] = []
  for (const domain of domains) {
    const ref = cfg.kumaMonitors[domain]
    if (!ref) continue
    for (const [field, kind] of KIND_FIELDS) {
      const id = ref[field]
      if (typeof id === "number") targets.push({ domain, kind, id })
    }
  }

  if (targets.length === 0) {
    return {
      ok: false,
      reason: "no_monitors_registered",
      message: opts.domain
        ? `No Kuma monitors registered for "${opts.domain}" in SpinupTUI.`
        : "No Kuma monitors registered for any site in SpinupTUI.",
    }
  }

  try {
    const { result } = await withKuma(cfg.uptimeKuma, async (kuma) => {
      const perTarget = await Promise.all(
        targets.map(async (t) => {
          try {
            return { t, beats: await kuma.getMonitorBeats(t.id, opts.hours) }
          } catch {
            return { t, beats: [] as KumaBeat[] }
          }
        }),
      )
      const events: IncidentEvent[] = []
      for (const { t, beats } of perTarget) {
        for (const b of beats) {
          if (!b.important) continue
          const status = STATUS_LABEL[b.status] ?? "pending"
          const message = b.msg || ""
          // The fatal sentinel is registered under the server's vanity domain,
          // not the site that's actually broken — a down beat pushed BY OUR
          // OWN cron carries the real, comma-separated affected domain(s) as
          // msg instead. But Kuma can ALSO generate its own synthetic down
          // beats on this same push monitor (e.g. "No heartbeat in the time
          // window" if the cron itself stops beating) — those are an
          // infrastructure signal about the server, not a parseable domain
          // list, and must NOT be mistaken for one (confirmed live: this
          // exact message has no commas and isn't a hostname). Only messages
          // that parse cleanly as a comma-separated list of hostname-shaped
          // tokens get split into per-domain events; anything else — Kuma's
          // own wording included — stays tagged to the vanity domain like
          // every other kind.
          const domainList = message.split(",").map((d) => d.trim())
          const looksLikeDomainList = domainList.every((d) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(d))
          if (t.kind === "fatal" && status === "down" && looksLikeDomainList) {
            for (const domain of domainList) {
              events.push({ domain, kind: t.kind, status, time: b.time, message })
            }
            continue
          }
          events.push({ domain: t.domain, kind: t.kind, status, time: b.time, message })
        }
      }
      events.sort((a, b) => a.time.localeCompare(b.time))
      return events
    })
    return { ok: true, windowHours: opts.hours, events: result }
  } catch (err) {
    const message = err instanceof KumaError ? err.message : `Unexpected error: ${(err as Error).message}`
    return { ok: false, reason: "kuma_error", message }
  }
}

// `sentinel attach`: adopts an existing Kuma's monitors, because a fresh install
// connected to a Kuma full of them still sees none (`incidents` reads the local
// registry). The registry is rebuilt from what Kuma already knows.
//
// Read-only toward Kuma and the servers: it never creates, renames or edits a
// monitor, and never generates a push token, because the server crons are already
// pushing to the existing ones. Re-running only fills gaps.

import type { KumaMonitorRef } from "../config.ts"
import type { KumaMonitor } from "./uptimeKuma.ts"

// SpinupTUI's own naming convention, longest suffix first.
const SUFFIXES: [string, keyof KumaMonitorRef, (keyof KumaMonitorRef)?][] = [
  [" php-fatal", "fatalId", "fatalToken"],
  [" cache-bypass", "bypassId"],
  [" front page", "fingerprintId"],
  [" redis", "redisId", "redisToken"],
  [" load", "pushId", "pushToken"],
]

export interface AttachMatch {
  domain: string
  field: keyof KumaMonitorRef
  monitorId: number
  name: string
}

export interface AttachPlan {
  exact: AttachMatch[]
  likely: AttachMatch[]
  unmonitored: string[]
  strangers: string[]
  already: number
}

function nameMatch(m: KumaMonitor): { domain: string; field: keyof KumaMonitorRef; token?: keyof KumaMonitorRef } {
  for (const [suffix, field, token] of SUFFIXES) if (m.name.endsWith(suffix)) return { domain: m.name.slice(0, -suffix.length), field, token }
  return { domain: m.name, field: "healthId" }
}

function urlHost(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname.toLowerCase() : null
  } catch {
    return null
  }
}

// `domains` is every name a monitor might use; `primary` is one per site, so a
// site with extra domains counts once when listing what has no monitor.
export function planAttach(monitors: KumaMonitor[], domains: string[], registry: Record<string, KumaMonitorRef>, primary: string[] = domains): AttachPlan {
  const sites = new Set(domains)
  const has = (domain: string, field: keyof KumaMonitorRef) => typeof registry[domain]?.[field] === "number"
  const taken = new Set(Object.values(registry).flatMap((r) => Object.entries(r).filter(([k, v]) => k.endsWith("Id") && typeof v === "number").map(([, v]) => v as number)))
  const plan: AttachPlan = { exact: [], likely: [], unmonitored: [], strangers: [], already: 0 }
  const covered = new Set(Object.keys(registry).filter((d) => registry[d]?.healthId))
  const leftover: KumaMonitor[] = []
  for (const m of monitors) {
    if (taken.has(m.id)) {
      plan.already++
      continue
    }
    const { domain, field } = nameMatch(m)
    if (sites.has(domain) && !has(domain, field)) {
      plan.exact.push({ domain, field, monitorId: m.id, name: m.name })
      if (field === "healthId") covered.add(domain)
    } else leftover.push(m)
  }
  for (const m of leftover) {
    const host = urlHost(m.url)
    const domain = host && (sites.has(host) ? host : sites.has(host.replace(/^www\./, "")) ? host.replace(/^www\./, "") : null)
    if (domain && m.type === "http" && !covered.has(domain)) {
      plan.likely.push({ domain, field: "healthId", monitorId: m.id, name: m.name })
      covered.add(domain)
    } else plan.strangers.push(m.name)
  }
  plan.unmonitored = primary.filter((d) => !covered.has(d) && !registry[d]).sort()
  return plan
}

// The registry after attaching: existing entries are never overwritten, and each
// push monitor keeps the token Kuma already holds.
export function applyAttach(registry: Record<string, KumaMonitorRef>, matches: AttachMatch[], monitors: KumaMonitor[]): Record<string, KumaMonitorRef> {
  const byId = new Map(monitors.map((m) => [m.id, m]))
  const out: Record<string, KumaMonitorRef> = structuredClone(registry)
  for (const a of matches) {
    const ref = (out[a.domain] ??= {}) as Record<string, unknown>
    if (typeof ref[a.field] === "number") continue
    ref[a.field] = a.monitorId
    const m = byId.get(a.monitorId)
    const token = SUFFIXES.find(([, field]) => field === a.field)?.[2]
    if (token && m?.pushToken) ref[token] = m.pushToken
    if (a.field === "fingerprintId" && typeof m?.keyword === "string") {
      ref.fingerprint = { keyword: m.keyword, kind: "attached", detail: "", interval: Number(m.interval) || 300, derivedAt: new Date().toISOString() }
    }
  }
  return out
}

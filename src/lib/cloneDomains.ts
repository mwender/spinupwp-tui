// Carry a site's additional domains onto its clone. A freshly created dest site
// answers ONLY its primary domain (nginx server_name has nothing else — verified on
// the test boxes), so without this step the DNS cutover would repoint www/extra
// hostnames at a server that doesn't serve them. Redirect settings (enabled/type/
// destination) are copied verbatim from the source. Idempotent: domains already on
// the dest are skipped, so per-site retries re-run it safely.

import type { SpinupWPClientLike } from "../api/client.ts"
import type { AdditionalDomain } from "../api/types.ts"

const EVENT_DONE = new Set(["deployed", "completed", "provisioned", "finished", "success"])
const EVENT_FAIL = new Set(["failed", "errored", "error"])

type PollOutcome = { outcome: "done" } | { outcome: "failed" } | { outcome: "timeout"; lastStatus?: string }

// 5s cadence; a transient failure to READ the event is not the event failing —
// tolerate a few consecutive API errors (the client already absorbs 429 bursts).
// The timeout is a generous BACKSTOP, not an expectation: SpinupWP serializes
// events per server, so under a concurrent clone an add-domain event can sit
// queued for minutes behind site-creates. (The 2026-07-07 sparkmamas run sat
// queued 173s and a flat 180s deadline declared it failed 12s before it
// deployed — every timeout must be reported as a timeout, never as a failure.)
export async function pollEvent(client: SpinupWPClientLike, eventId: number, timeoutMs = 1_800_000, pollMs = 5000): Promise<PollOutcome> {
  const deadline = Date.now() + timeoutMs
  let apiErrs = 0
  let lastStatus: string | undefined
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    try {
      const e = await client.getEvent(eventId)
      apiErrs = 0
      lastStatus = e.status
      if (EVENT_FAIL.has(e.status)) return { outcome: "failed" }
      if (EVENT_DONE.has(e.status) || e.finished_at) return { outcome: "done" }
    } catch {
      if (++apiErrs >= 3) return { outcome: "timeout", lastStatus }
    }
  }
  // One last look before giving up — the event may have finished on the wire.
  try {
    const e = await client.getEvent(eventId)
    if (EVENT_FAIL.has(e.status)) return { outcome: "failed" }
    if (EVENT_DONE.has(e.status) || e.finished_at) return { outcome: "done" }
    lastStatus = e.status
  } catch {
    /* keep the polled status */
  }
  return { outcome: "timeout", lastStatus }
}

export interface DomainSyncResult {
  added: string[]
  skipped: string[] // already present on the dest (retry path)
  failed: { domain: string; error: string }[]
}

export async function syncAdditionalDomains(
  client: SpinupWPClientLike,
  destSiteId: number,
  sourceDomains: AdditionalDomain[],
  log?: (entry: Record<string, unknown>) => void,
): Promise<DomainSyncResult> {
  const result: DomainSyncResult = { added: [], skipped: [], failed: [] }
  if (sourceDomains.length === 0) return result
  // A failed listing falls back to "add everything" — a duplicate add errors
  // per-domain and lands in `failed` with the API's message rather than hiding.
  let existing = new Set<string>()
  try {
    existing = new Set((await client.listSiteDomains(destSiteId)).map((d) => d.domain))
  } catch {
    /* fall through */
  }
  for (const d of sourceDomains) {
    if (existing.has(d.domain)) {
      result.skipped.push(d.domain)
      continue
    }
    try {
      const ev = await client.addSiteDomain(destSiteId, {
        domain: d.domain,
        redirect: d.redirect ? { enabled: d.redirect.enabled, type: d.redirect.type, destination: d.redirect.destination } : undefined,
      })
      const res = await pollEvent(client, ev.event_id)
      if (res.outcome === "done") {
        result.added.push(d.domain)
        log?.({ event: "domain-add", destSiteId, domain: d.domain, eventId: ev.event_id, ok: true })
      } else if (res.outcome === "timeout") {
        // NOT a SpinupWP failure — we stopped waiting. Retrying the site is safe
        // (already-present domains are skipped), so point the user there.
        const error = `gave up waiting for add-domain event ${ev.event_id}${res.lastStatus ? ` (still "${res.lastStatus}")` : ""} — it may yet finish on SpinupWP; retry the site to re-check`
        result.failed.push({ domain: d.domain, error })
        log?.({ event: "domain-add", destSiteId, domain: d.domain, eventId: ev.event_id, ok: false, outcome: "timeout", lastStatus: res.lastStatus })
      } else {
        // Pull the event's own output so the roster/log say WHY, not just "failed".
        let out = ""
        try {
          out = ((await client.getEvent(ev.event_id)).output ?? "").trim()
        } catch {
          /* best-effort */
        }
        const error = `add-domain event ${ev.event_id} failed${out ? `: …${out.slice(-200)}` : " on SpinupWP"}`
        result.failed.push({ domain: d.domain, error })
        log?.({ event: "domain-add", destSiteId, domain: d.domain, eventId: ev.event_id, ok: false, output: out })
      }
    } catch (err) {
      const error = (err as Error).message
      result.failed.push({ domain: d.domain, error })
      log?.({ event: "domain-add", destSiteId, domain: d.domain, ok: false, error })
    }
  }
  return result
}

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

// 5s cadence; a transient failure to READ the event is not the event failing —
// tolerate a few consecutive API errors (the client already absorbs 429 bursts).
async function pollEvent(client: SpinupWPClientLike, eventId: number, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let apiErrs = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    try {
      const e = await client.getEvent(eventId)
      apiErrs = 0
      if (EVENT_FAIL.has(e.status)) return false
      if (EVENT_DONE.has(e.status) || e.finished_at) return true
    } catch {
      if (++apiErrs >= 3) return false
    }
  }
  return false
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
      const ok = await pollEvent(client, ev.event_id)
      if (ok) {
        result.added.push(d.domain)
        log?.({ event: "domain-add", destSiteId, domain: d.domain, eventId: ev.event_id, ok })
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
        log?.({ event: "domain-add", destSiteId, domain: d.domain, eventId: ev.event_id, ok, output: out })
      }
    } catch (err) {
      const error = (err as Error).message
      result.failed.push({ domain: d.domain, error })
      log?.({ event: "domain-add", destSiteId, domain: d.domain, ok: false, error })
    }
  }
  return result
}

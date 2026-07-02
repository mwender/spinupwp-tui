// Carry a site's additional domains onto its clone. A freshly created dest site
// answers ONLY its primary domain (nginx server_name has nothing else — verified on
// the test boxes), so without this step the DNS cutover would repoint www/extra
// hostnames at a server that doesn't serve them. Redirect settings (enabled/type/
// destination) are copied verbatim from the source. Idempotent: domains already on
// the dest are skipped, so per-site retries re-run it safely.

import type { SpinupWPClient } from "../api/client.ts"
import type { AdditionalDomain } from "../api/types.ts"

const EVENT_DONE = new Set(["deployed", "completed", "provisioned", "finished", "success"])
const EVENT_FAIL = new Set(["failed", "errored", "error"])

async function pollEvent(client: SpinupWPClient, eventId: number, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const e = await client.getEvent(eventId)
      if (EVENT_FAIL.has(e.status)) return false
      if (EVENT_DONE.has(e.status) || e.finished_at) return true
    } catch {
      return false
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
  client: SpinupWPClient,
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
      if (ok) result.added.push(d.domain)
      else result.failed.push({ domain: d.domain, error: "the add-domain event failed on SpinupWP" })
      log?.({ event: "domain-add", destSiteId, domain: d.domain, ok })
    } catch (err) {
      const error = (err as Error).message
      result.failed.push({ domain: d.domain, error })
      log?.({ event: "domain-add", destSiteId, domain: d.domain, ok: false, error })
    }
  }
  return result
}

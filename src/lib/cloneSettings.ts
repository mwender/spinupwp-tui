// Carry a site's SpinupWP settings onto its clone: page cache (on/off, duration,
// exclusions), the nginx security toggles, path redirects, and the server-level WP
// cron interval. The create payload can only say "page cache on", so without this
// a clone comes out with SpinupWP's defaults for everything else. Each setting is
// compared first and only a difference is written, so a retry re-runs it safely.
//
// Not carried here: basic auth (the password can't be read from the API — the
// result flags it instead) and backups (stored per DOMAIN in the bucket, so a clone
// backing up before DNS cutover would write over production's files; they're
// applied at cutover).

import type { SpinupWPClientLike } from "../api/client.ts"
import { WP_CRON_INTERVALS, type NginxSettings, type PageCachePayload, type PageCacheSettings, type PathRedirect, type Site } from "../api/types.ts"
import { pollEvent } from "./cloneDomains.ts"

export interface SettingsCarryResult {
  carried: string[] // short labels for what was written ("page cache", "3 redirects", …)
  failed: { what: string; error: string }[]
  basicAuthMissing: boolean // the source is password-protected, the clone isn't
}

type Log = (entry: Record<string, unknown>) => void

// Page-cache exclusion lists read back as one pipe-joined regex but are written one
// entry per line. Split on top-level pipes only, so an alternation inside a group
// or class — "(a|b)", "[|]" — stays one entry. Exported for the test harness.
export function splitCacheList(joined: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ""
  for (let i = 0; i < joined.length; i++) {
    const ch = joined[i]!
    if (ch === "\\") {
      cur += ch + (joined[i + 1] ?? "")
      i++
      continue
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) depth--
    if (ch === "|" && depth === 0) {
      out.push(cur)
      cur = ""
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.filter((e) => e !== "")
}

const CACHE_LISTS = ["path_exclusions", "cookie_exclusions", "ignored_query_params"] as const

// What to send so the dest's page cache matches the source's: only the fields that
// differ, and never a list the source leaves unset (null reads as "SpinupWP's
// default", which the dest already has).
function pageCacheDiff(src: PageCacheSettings, dst: PageCacheSettings | undefined): PageCachePayload {
  const out: PageCachePayload = {}
  if (src.duration != null && src.duration_unit != null && (src.duration !== dst?.duration || src.duration_unit !== dst?.duration_unit)) {
    out.duration = src.duration
    out.duration_unit = src.duration_unit
  }
  for (const k of CACHE_LISTS) {
    const v = src[k]
    if (v != null && v !== dst?.[k]) out[k] = splitCacheList(v).join("\n")
  }
  return out
}

// Wait for each event and turn the outcome into an error string (undefined = done).
async function settle(client: SpinupWPClientLike, eventIds: number[]): Promise<string | undefined> {
  for (const id of eventIds) {
    const r = await pollEvent(client, id)
    if (r.outcome === "failed") return `event ${id} failed on SpinupWP`
    if (r.outcome === "timeout") return `gave up waiting for event ${id}${r.lastStatus ? ` (still "${r.lastStatus}")` : ""} — retry the site to re-check`
  }
  return undefined
}

const redirectKey = (r: Pick<PathRedirect, "from" | "to">) => `${r.from}\u0000${r.to}`

export async function carrySiteSettings(
  client: SpinupWPClientLike,
  sourceSiteId: number,
  destSiteId: number,
  wpCron: { source?: number | null; dest?: number | null },
  log?: Log,
): Promise<SettingsCarryResult> {
  const result: SettingsCarryResult = { carried: [], failed: [], basicAuthMissing: false }
  let src: Site
  let dst: Site
  try {
    ;[src, dst] = await Promise.all([client.getSite(sourceSiteId), client.getSite(destSiteId)])
  } catch (err) {
    result.failed.push({ what: "settings", error: `couldn't read the sites: ${(err as Error).message}` })
    return result
  }

  // Each step records its own outcome; one failing never stops the rest.
  const step = async (what: string, run: () => Promise<number[] | null>) => {
    try {
      const events = await run()
      if (events == null) return // nothing to change
      const error = await settle(client, events)
      if (error) {
        result.failed.push({ what, error })
        log?.({ event: "settings-carry", what, ok: false, error })
      } else {
        result.carried.push(what)
        log?.({ event: "settings-carry", what, ok: true })
      }
    } catch (err) {
      const error = (err as Error).message
      result.failed.push({ what, error })
      log?.({ event: "settings-carry", what, ok: false, error })
    }
  }

  // Page cache
  const sc = src.page_cache
  if (sc) {
    await step("page cache", async () => {
      if (!sc.enabled) return dst.page_cache?.enabled ? [(await client.disablePageCache(destSiteId)).event_id] : null
      const diff = pageCacheDiff(sc, dst.page_cache)
      if (!dst.page_cache?.enabled) return [(await client.enablePageCache(destSiteId, diff)).event_id]
      return Object.keys(diff).length > 0 ? [(await client.updatePageCache(destSiteId, diff)).event_id] : null
    })
  }

  // Nginx security toggles (public_folder is set at create and handled by the pull)
  const sn = src.nginx ?? {}
  const nginx: NginxSettings = {}
  for (const k of ["uploads_directory_protected", "xmlrpc_protected", "subdirectory_rewrite_in_place"] as const) {
    if (sn[k] != null && sn[k] !== dst.nginx?.[k]) nginx[k] = sn[k]
  }
  if (Object.keys(nginx).length > 0) {
    await step("security settings", async () => (await client.updateNginx(destSiteId, nginx)).event_ids)
  }

  // Path redirects: add the source's that the dest lacks. The dest's own extras
  // are left alone (a clone shouldn't delete anything).
  let srcRedirects: PathRedirect[] = []
  try {
    srcRedirects = await client.listPathRedirects(sourceSiteId)
  } catch (err) {
    result.failed.push({ what: "redirects", error: `couldn't list the source's redirects: ${(err as Error).message}` })
  }
  if (srcRedirects.length > 0) {
    let have = new Set<string>()
    try {
      have = new Set((await client.listPathRedirects(destSiteId)).map(redirectKey))
    } catch {
      /* add them all; a duplicate is rejected per redirect and reported */
    }
    const missing = srcRedirects.filter((r) => !have.has(redirectKey(r)))
    if (missing.length > 0) {
      await step(`${missing.length} redirect${missing.length === 1 ? "" : "s"}`, async () => {
        const events: number[] = []
        for (const r of missing) events.push((await client.addPathRedirect(destSiteId, { from: r.from, to: r.to, type: r.type })).event_id)
        return events
      })
    }
  }

  // WP cron: both ends' intervals come from their crontabs (undefined = unread,
  // null = no managed job recognized). Only an interval is ever carried: a source
  // with no recognizable job might have WP cron off, or a line shape we don't
  // parse, and switching the clone's off on a guess is worse than leaving it.
  const want = wpCron.source
  const have = wpCron.dest
  if (want != null && have !== undefined && want !== have) {
    if (!(WP_CRON_INTERVALS as readonly number[]).includes(want)) {
      result.failed.push({ what: "WP cron", error: `the source runs WP cron every ${want} min, which SpinupWP's API doesn't offer` })
    } else {
      await step(`WP cron every ${want} min`, async () => [(have == null ? await client.enableWpCron(destSiteId, want) : await client.updateWpCron(destSiteId, want)).event_id])
    }
  }

  result.basicAuthMissing = !!src.basic_auth?.enabled && !dst.basic_auth?.enabled
  return result
}

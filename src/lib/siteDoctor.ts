// The site doctor (site monitoring Phase 2) — an on-demand, READ-ONLY diagnosis
// of the "200 OK but wrong page" failure class. Pure HTTP: no SSH, no Kuma, no
// writes, so it works on any site with zero setup.
//
// The centerpiece is the cache differential. SpinupWP's nginx page cache
// answers with `fastcgi-cache: HIT|MISS|BYPASS` and honors the default
// `wordpress_no_cache` cookie exclusion (both verified live on production
// boxes, and the header set is what the spinupwp plugin registers with WP
// core's Site Health page-cache test). So the doctor fetches the page twice —
// once normally (cache-eligible) and once with the bypass cookie (same URL,
// only the cache layer differs) — and compares WP's body_class() template
// tokens between the two. A mismatch is PROOF the cache is serving a different
// template than PHP renders right now: the purge-fixable condition, diagnosed
// rather than guessed. The headers tell us which layer answered each request,
// so the differential asserts its own validity instead of assuming it.
//
// Verdict precedence: down > stale-cache > recalibrate > healthy, with
// "inconclusive" when the evidence doesn't support any of them. The doctor
// ends at diagnosis + a copyable runbook — deliberately no auto-heal (the
// operator does the surgery; builder-specific lines appear only on positive
// evidence in the served markup).

import { bodyClassOf } from "./siteFingerprint.ts"

export interface DoctorCheck {
  label: string
  status: "ok" | "warn" | "bad" | "info"
  detail: string
}

export type DoctorVerdict = "healthy" | "stale-cache" | "recalibrate" | "down" | "inconclusive"

export interface DoctorReport {
  verdict: DoctorVerdict
  summary: string
  checks: DoctorCheck[]
  runbook: string[] // shell lines (plus comments) when something is fixable; empty otherwise
}

interface Probe {
  ok: boolean
  status: number
  ms: number
  html: string
  cache: string | null // fastcgi-cache header, uppercased
  bypassReason: string | null
  error?: string
}

const FETCH_TIMEOUT_MS = 20_000
const MAX_HTML_BYTES = 512 * 1024

// The body_class() tokens that identify WHICH template won — the set the
// differential compares. Cosmetic/theme classes are deliberately excluded so a
// plugin adding a class doesn't read as a template change.
const TEMPLATE_TOKEN =
  /^(home|blog|front-page|search|search-results|search-no-results|error404|single|singular|page|archive|category|tag|author|date|attachment|page-id-\d+|postid-\d+|single-[a-z0-9_-]+)$/

async function probe(url: string, cookie?: string): Promise<Probe> {
  const started = performance.now()
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": "spinup-tui (site doctor)",
        "cache-control": "no-store",
        ...(cookie ? { cookie } : {}),
      },
    })
    const html = (await res.text()).slice(0, MAX_HTML_BYTES)
    return {
      ok: res.ok,
      status: res.status,
      ms: Math.round(performance.now() - started),
      html,
      cache: res.headers.get("fastcgi-cache")?.toUpperCase() ?? null,
      bypassReason: res.headers.get("fastcgi-cache-bypass-reason"),
    }
  } catch (err) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - started), html: "", cache: null, bypassReason: null, error: (err as Error).message }
  }
}

function templateTokens(html: string): string[] | null {
  const cls = bodyClassOf(html)
  if (!cls) return null
  const tokens = cls.tokens.filter((t) => TEMPLATE_TOKEN.test(t)).sort()
  return tokens.length > 0 ? tokens : null
}

export async function runSiteDoctor(opts: {
  url: string
  expectedKeyword?: string | null // the calibrated fingerprint, when one exists
  pageCacheEnabled?: boolean | null // from the SpinupWP API; null = unknown
  sshTarget?: string | null // "site_user@host" for the runbook's ssh line
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  const runbook: string[] = []

  const cached = await probe(opts.url)
  if (!cached.ok) {
    checks.push({ label: "reachability", status: "bad", detail: cached.error ?? `answered ${cached.status}` })
    return { verdict: "down", summary: "The site isn't answering — this isn't a cache problem.", checks, runbook }
  }
  checks.push({ label: "reachability", status: "ok", detail: `200 in ${cached.ms}ms` })

  const fresh = await probe(opts.url, "wordpress_no_cache=1")

  // What layer served the plain request?
  if (cached.cache === "HIT") {
    checks.push({ label: "page cache", status: "ok", detail: "served from the page cache (HIT)" })
  } else if (cached.cache) {
    checks.push({ label: "page cache", status: "info", detail: `${cached.cache} — freshly rendered, nothing stale to compare` })
  } else if (opts.pageCacheEnabled === false) {
    checks.push({ label: "page cache", status: "info", detail: "disabled for this site (per SpinupWP)" })
  } else {
    checks.push({ label: "page cache", status: "warn", detail: "no fastcgi-cache header — cache layer not verifiable here" })
  }

  // Did the bypass actually bypass? The header proves it either way. With the
  // page cache off, every render is fresh and there's nothing to bypass — that
  // is expected state, not a warning.
  const cacheOff = opts.pageCacheEnabled === false && !cached.cache
  const bypassConfirmed = fresh.ok && fresh.cache === "BYPASS"
  if (bypassConfirmed) {
    checks.push({ label: "bypass", status: "ok", detail: `fresh render confirmed (BYPASS: ${fresh.bypassReason ?? "cookie"}) in ${fresh.ms}ms` })
  } else if (cacheOff && fresh.ok) {
    checks.push({ label: "bypass", status: "info", detail: "page cache off — every render is already fresh" })
  } else if (fresh.ok) {
    checks.push({ label: "bypass", status: "warn", detail: `couldn't confirm a fresh render (${fresh.cache ?? "no cache header"}) — differential unverified` })
  } else {
    checks.push({ label: "bypass", status: "warn", detail: fresh.error ?? `bypass request answered ${fresh.status}` })
  }

  // The differential: cached template identity vs freshly rendered identity.
  const cachedTokens = templateTokens(cached.html)
  const freshTokens = fresh.ok ? templateTokens(fresh.html) : null
  let staleCache = false
  if (cached.cache === "HIT" && bypassConfirmed && cachedTokens && freshTokens) {
    if (cachedTokens.join(" ") === freshTokens.join(" ")) {
      checks.push({ label: "template", status: "ok", detail: `cached and fresh renders agree (${freshTokens.slice(0, 3).join(" ")})` })
    } else {
      staleCache = true
      checks.push({ label: "template", status: "bad", detail: `cached says “${cachedTokens.join(" ")}” but PHP renders “${freshTokens.join(" ")}”` })
    }
  } else if (cachedTokens && freshTokens) {
    checks.push({ label: "template", status: "info", detail: `both renders show “${freshTokens.slice(0, 3).join(" ")}” (differential not provable this pass)` })
  } else {
    checks.push({ label: "template", status: "info", detail: "no body_class() tokens to compare — theme doesn't emit them" })
  }

  // The calibrated fingerprint, when the site has one.
  let recalibrate = false
  if (opts.expectedKeyword) {
    const inCached = cached.html.includes(opts.expectedKeyword)
    const inFresh = fresh.ok ? fresh.html.includes(opts.expectedKeyword) : null
    if (inCached) {
      checks.push({ label: "fingerprint", status: "ok", detail: "calibrated fingerprint present on the live page" })
    } else if (inFresh) {
      staleCache = true
      checks.push({ label: "fingerprint", status: "bad", detail: "missing from the cached page but present in a fresh render" })
    } else {
      recalibrate = true
      checks.push({ label: "fingerprint", status: "warn", detail: "gone from the live site entirely — the page changed, not the cache" })
    }
  }

  if (fresh.ok) {
    checks.push({
      label: "timing",
      status: "info",
      detail: cached.cache === "HIT" ? `cached ${cached.ms}ms · uncached ${fresh.ms}ms` : `renders: ${cached.ms}ms · ${fresh.ms}ms`,
    })
  }

  if (staleCache) {
    // Builder-specific runbook lines only on positive evidence in the markup.
    const elementor = /wp-content\/plugins\/elementor\/|elementor-kit-\d/.test(fresh.ok ? fresh.html : cached.html)
    if (opts.sshTarget) runbook.push(`ssh ${opts.sshTarget}`)
    if (elementor) runbook.push("wp elementor flush_css   # elementor detected — this also purges SpinupWP's caches")
    else runbook.push("wp spinupwp cache purge-site")
    runbook.push("# or: press P on this site (purge via API), then re-run d")
    return { verdict: "stale-cache", summary: "The page cache is serving a different page than PHP renders — purge it.", checks, runbook }
  }
  if (recalibrate) {
    return { verdict: "recalibrate", summary: "The site renders fine but no longer matches its calibrated fingerprint — press f to recalibrate.", checks, runbook }
  }
  if (cachedTokens || opts.expectedKeyword) {
    const proved = cached.cache === "HIT" && bypassConfirmed
    return { verdict: "healthy", summary: proved ? "Serving the right page, and the cache agrees with a fresh render." : "Serving the right page.", checks, runbook }
  }
  return { verdict: "inconclusive", summary: "Reachable, but there's no template identity or fingerprint to judge against.", checks, runbook }
}

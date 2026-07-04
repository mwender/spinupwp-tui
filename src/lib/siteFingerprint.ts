// Derive a template-identity fingerprint from a site's LIVE front page — the
// calibration step behind the front-page Kuma monitor (site monitoring Phase 1).
//
// Why not a hand-picked headline keyword: content is the one thing a site owner
// is allowed to change, so a headline monitor breaks the day someone edits the
// copy. WordPress instead stamps the winning template into body_class() on every
// request (`home` / `page-id-N` / `front-page` vs `search` / `error404`), so a
// template-derived token catches "the page cache is serving the wrong page" —
// verified live 2026-07-04: a page-cache incident served `class="search …"`
// where `class="home …"` belonged, with HTTP 200 the whole time.
//
// The candidate ladder (most → least distinctive) is read from what the page
// ACTUALLY serves right now — the page is presumed healthy at calibration time:
//   1. body class starting with `home`/`blog` → `class="home` (prefix-anchored,
//      can't false-match in prose)
//   2. a `page-id-N` token → `page-id-N`
//   3. a `front-page` token → `front-page`
//   4. the canonical <link> tag → its exact text
// Non-WP sites and body_class-less themes fall down the ladder naturally
// (canonical), and a page with none of these reports WHY instead of registering
// a junk monitor.
//
// Validation: a throwaway search URL (`?s=…` — bypasses the page cache and, on
// WP, renders a different template) is fetched and the chosen keyword must be
// ABSENT there; a keyword that also matches the search template couldn't
// discriminate. Sites that ignore `?s=` (serve the same page back) make the
// probe inconclusive — the fingerprint is then accepted unvalidated, with a note.

export interface Fingerprint {
  kind: "body-class" | "canonical"
  keyword: string // the literal substring the Kuma keyword monitor asserts
  detail: string // human-readable description for the overlay / done message
}

export type DeriveResult = { ok: true; fingerprint: Fingerprint; validated: boolean; note?: string } | { ok: false; error: string }

const FETCH_TIMEOUT_MS = 20_000
// The body tag and canonical link live near the top of the document; capping the
// read keeps a pathological page from ballooning memory.
const MAX_HTML_BYTES = 512 * 1024

async function fetchHtml(url: string): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "spinup-tui (front-page fingerprint calibration)" },
    })
    if (!res.ok) return { ok: false, error: `The page answered ${res.status} — calibrate while it's healthy.` }
    return { ok: true, html: (await res.text()).slice(0, MAX_HTML_BYTES) }
  } catch (err) {
    return { ok: false, error: `Couldn't fetch ${url}: ${(err as Error).message}` }
  }
}

export function bodyClassOf(html: string): { quote: string; tokens: string[] } | null {
  const body = html.match(/<body[^>]*>/i)?.[0]
  if (!body) return null
  const cls = body.match(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
  if (!cls) return null
  const value = (cls[1] ?? cls[2] ?? "").trim()
  if (!value) return null
  return { quote: cls[1] != null ? '"' : "'", tokens: value.split(/\s+/) }
}

function candidatesFrom(html: string): Fingerprint[] {
  const out: Fingerprint[] = []
  const cls = bodyClassOf(html)
  if (cls) {
    const first = cls.tokens[0]
    if (first === "home" || first === "blog") {
      out.push({ kind: "body-class", keyword: `class=${cls.quote}${first}`, detail: `body class “${first}”` })
    }
    const pageId = cls.tokens.find((t) => /^page-id-\d+$/.test(t))
    if (pageId) out.push({ kind: "body-class", keyword: pageId, detail: `body class “${pageId}”` })
    if (cls.tokens.includes("front-page")) out.push({ kind: "body-class", keyword: "front-page", detail: "body class “front-page”" })
  }
  const canonical = html.match(/<link[^>]*rel=["']canonical["'][^>]*>/i)?.[0]
  // A canonical tag is only a usable keyword when it's a sane length (some SEO
  // plugins emit data-bloated tags that would make a brittle, unreadable match).
  if (canonical && canonical.length <= 300) out.push({ kind: "canonical", keyword: canonical, detail: "canonical link tag" })
  return out
}

export async function deriveFingerprint(homeUrl: string): Promise<DeriveResult> {
  const home = await fetchHtml(homeUrl)
  if (!home.ok) return { ok: false, error: home.error }
  const candidates = candidatesFrom(home.html)
  if (candidates.length === 0) {
    return { ok: false, error: "No template fingerprint on the front page (no WP body classes or canonical link) — this site would need a hand-made keyword monitor in Kuma." }
  }

  const sep = homeUrl.includes("?") ? "&" : "?"
  const probe = await fetchHtml(`${homeUrl}${sep}s=spinup-fingerprint-probe`)
  if (!probe.ok) return { ok: true, fingerprint: candidates[0]!, validated: false, note: "comparison probe unreachable — fingerprint unvalidated" }

  const homeCls = bodyClassOf(home.html)
  const probeCls = bodyClassOf(probe.html)
  if (homeCls && probeCls && homeCls.tokens.join(" ") === probeCls.tokens.join(" ")) {
    // The site serves the same page for `?s=` (no search feature) — the probe
    // can't tell a distinctive keyword from a useless one.
    return { ok: true, fingerprint: candidates[0]!, validated: false, note: "site ignores search URLs — fingerprint unvalidated" }
  }

  const distinct = candidates.find((c) => !probe.html.includes(c.keyword))
  if (distinct) return { ok: true, fingerprint: distinct, validated: true }
  return { ok: false, error: "Every candidate fingerprint also appears on a non-front page — nothing distinctive to monitor." }
}

// Samurai's rule templates. Every nginx rule Samurai writes is one of these,
// with typed, validated parameters: an agent (or Sentinel) chooses a template
// and its parameters, and never writes nginx. Spec: "Templates, not
// free-form nginx".
//
// Sentinel's validateFix (lib/todos.ts) is a first filter when a to-do is
// created. This is the boundary: nothing is rendered that fails here.
//
// Each template renders a block tagged with its to-do and proposal, and lists
// the checks that prove it from outside once it's live.

import type { Fix } from "../todos.ts"

export const TEMPLATES = ["deny-paths", "gone-paths", "block-user-agent", "cloudflare-real-ip"] as const
export type TemplateName = (typeof TEMPLATES)[number]

// One request made from outside after the rule is live.
export interface Check {
  label: string
  path: string
  userAgent?: string
  expect: "status" | "refused" | "same-as-before"
  status?: number
}

export interface Rendered {
  template: TemplateName
  lines: string[] // the nginx, without the tag line
  checks: Check[]
  notes: string[] // what was dropped or can't be checked, in plain words
}

export type RenderResult = { ok: true; rendered: Rendered } | { ok: false; message: string }

// URLs no rule may ever catch: a WordPress site that can't serve these is
// broken, whatever the rule was for.
export const PROTECTED_PATHS = [
  "/",
  "/index.php",
  "/wp-login.php",
  "/wp-admin/",
  "/wp-admin/admin-ajax.php",
  "/wp-admin/post.php",
  "/wp-json/",
  "/wp-json/wp/v2/posts",
  "/wp-cron.php",
  "/wp-content/uploads/2026/01/photo.jpg",
  "/wp-content/themes/theme/style.css",
  "/wp-content/plugins/plugin/script.js",
  "/wp-includes/js/jquery/jquery.min.js",
  "/feed/",
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/wp-sitemap.xml",
  "/robots.txt",
  "/favicon.ico",
  "/xmlrpc.php",
  "/.well-known/acme-challenge/token",
  "/sample-page/",
  "/2026/01/hello-world/",
  "/shop/",
  "/cart/",
  "/checkout/",
  "/my-account/",
]

// User agents no block may catch: search engines, social previews, the
// monitors watching the site, and ordinary browsers.
export const PROTECTED_AGENTS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/120.0.0.0 Safari/537.36",
  "Googlebot-Image/1.0",
  "Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
  "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
  "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Uptime-Kuma/1.23.16",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "WordPress/6.7; https://example.com",
  "SpinupTUI-Samurai/1 (verify)",
]

export const BROWSER_UA = PROTECTED_AGENTS[13]!

// ---- paths ------------------------------------------------------------------------

export type PathKind = "exact" | "prefix" | "regex" | "regex-ci"
export interface PathRule {
  kind: PathKind
  value: string
}

const LITERAL = /^\/[A-Za-z0-9._~%\-/]*$/
// The regex subset: literals, escapes, anchors, groups, alternation, classes
// and simple quantifiers. No braces (nginx syntax), quotes, spaces or
// semicolons, and a length cap.
const REGEX_SAFE = /^[A-Za-z0-9._~%\-/^$\\()|?*+[\]]+$/

export function parsePath(raw: string): { ok: true; rule: PathRule } | { ok: false; message: string } {
  const s = raw.trim()
  const m = /^(=|\^~|~\*|~)?\s*(\S+)$/.exec(s)
  if (!m) return { ok: false, message: `"${raw}" isn't a path` }
  const mod = m[1] ?? ""
  const value = m[2]!
  if (mod === "~" || mod === "~*") {
    if (value.length > 120 || !REGEX_SAFE.test(value)) return { ok: false, message: `the pattern "${value}" uses characters Samurai doesn't allow` }
    try {
      new RegExp(value)
    } catch {
      return { ok: false, message: `"${value}" isn't a valid pattern` }
    }
    if (/\(\?/.test(value) || /\\[1-9]/.test(value)) return { ok: false, message: `"${value}" uses regex features Samurai doesn't allow` }
    return { ok: true, rule: { kind: mod === "~" ? "regex" : "regex-ci", value } }
  }
  if (!LITERAL.test(value) || value.includes("..") || value.includes("//")) return { ok: false, message: `"${value}" isn't a plain path` }
  if (value === "/") return { ok: false, message: "a rule for / would catch the whole site" }
  // A plain prefix becomes ^~, so a PHP file under it can't slip past to
  // SpinupWP's `location ~ \.php$`.
  return { ok: true, rule: { kind: mod === "=" ? "exact" : "prefix", value } }
}

export function pathMatches(rule: PathRule, url: string): boolean {
  switch (rule.kind) {
    case "exact":
      return url === rule.value
    case "prefix":
      return url.startsWith(rule.value)
    case "regex":
      return new RegExp(rule.value).test(url)
    case "regex-ci":
      return new RegExp(rule.value, "i").test(url)
  }
}

export function locationOf(rule: PathRule): string {
  switch (rule.kind) {
    case "exact":
      return `location = ${rule.value}`
    case "prefix":
      return `location ^~ ${rule.value}`
    case "regex":
      return `location ~ ${rule.value}`
    case "regex-ci":
      return `location ~* ${rule.value}`
  }
}

// A URL that the rule matches, to request from outside; null when one can't be
// derived (a pattern with real alternatives), so that path isn't verified.
export function samplePath(rule: PathRule): string | null {
  if (rule.kind === "exact") return rule.value
  if (rule.kind === "prefix") return rule.value.endsWith("/") ? `${rule.value}samurai-check` : rule.value
  let s = rule.value.replace(/^\^/, "").replace(/\$$/, "")
  s = s.replace(/\\(.)/g, "$1")
  if (/[()|?*+[\]^$]/.test(s) || !s.startsWith("/")) return null
  return pathMatches(rule, s) ? s : null
}

function pathTemplate(name: "deny-paths" | "gone-paths", params: Record<string, unknown>): RenderResult {
  const raw = params.paths
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) return { ok: false, message: "paths must be a list of 1 to 20 paths" }
  const status = name === "gone-paths" ? 410 : params.status === undefined ? 403 : (params.status as number)
  if (name === "deny-paths" && ![403, 404, 444].includes(status)) return { ok: false, message: "status must be 403, 404 or 444" }
  const rules: PathRule[] = []
  for (const p of raw) {
    if (typeof p !== "string") return { ok: false, message: "every path must be text" }
    const r = parsePath(p)
    if (!r.ok) return { ok: false, message: r.message }
    const caught = PROTECTED_PATHS.find((u) => pathMatches(r.rule, u))
    if (caught) return { ok: false, message: `"${p}" would also catch ${caught}, which a WordPress site needs` }
    rules.push(r.rule)
  }
  const seen = new Set<string>()
  const lines: string[] = []
  const checks: Check[] = []
  const notes: string[] = []
  for (const r of rules) {
    const loc = locationOf(r)
    if (seen.has(loc)) continue
    seen.add(loc)
    lines.push(`${loc} { return ${status}; }`)
    const sample = samplePath(r)
    if (sample) checks.push({ label: `${sample} is ${status === 444 ? "refused" : status}`, path: sample, expect: status === 444 ? "refused" : "status", status })
    else notes.push(`${loc} can't be checked from outside: Samurai can't make a sample URL for that pattern.`)
  }
  checks.push({ label: "the home page answers as before", path: "/", expect: "same-as-before" })
  return { ok: true, rendered: { template: name, lines, checks, notes } }
}

// ---- user agents --------------------------------------------------------------------

const UA_SAFE = /^[A-Za-z0-9 ._\-/()|+:]{3,80}$/

function blockUserAgent(params: Record<string, unknown>): RenderResult {
  const pattern = params.pattern
  if (typeof pattern !== "string" || !UA_SAFE.test(pattern)) return { ok: false, message: "pattern must be 3 to 80 letters, digits, spaces or . _ - / ( ) | + :" }
  let re: RegExp
  try {
    re = new RegExp(pattern, "i")
  } catch {
    return { ok: false, message: `"${pattern}" isn't a valid pattern` }
  }
  const caught = PROTECTED_AGENTS.find((ua) => re.test(ua))
  if (caught) return { ok: false, message: `"${pattern}" would also block ${caught.slice(0, 60)}` }
  const status = params.status === undefined ? 403 : (params.status as number)
  if (![403, 444].includes(status)) return { ok: false, message: "status must be 403 or 444" }
  // The sample is the pattern itself when it's plain text, so the check sends
  // a user agent the rule must refuse.
  const plain = !/[()|+]/.test(pattern)
  const checks: Check[] = []
  const notes: string[] = []
  if (plain) checks.push({ label: `a request as "${pattern}" is ${status === 444 ? "refused" : status}`, path: "/", userAgent: `${pattern}/1.0`, expect: status === 444 ? "refused" : "status", status })
  else notes.push("The pattern has alternatives, so no sample user agent is sent; the browser check still runs.")
  checks.push({ label: "a browser still gets the home page as before", path: "/", userAgent: BROWSER_UA, expect: "same-as-before" })
  return { ok: true, rendered: { template: "block-user-agent", lines: [`if ($http_user_agent ~* "${pattern}") { return ${status}; }`], checks, notes } }
}

// ---- Cloudflare -----------------------------------------------------------------------

const CIDR4 = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/
const CIDR6 = /^[0-9a-f:]+\/\d{1,3}$/i

// The ranges come from Cloudflare when the proposal is made, and are recorded
// in it, with the date, so a later change can be noticed.
export function cloudflareRealIp(ranges: string[], fetchedOn: string): RenderResult {
  if (ranges.length < 5) return { ok: false, message: "Cloudflare's published list looked too short; not using it" }
  for (const r of ranges) if (!CIDR4.test(r) && !CIDR6.test(r)) return { ok: false, message: `"${r}" isn't an IP range` }
  const lines = [`# Cloudflare's ranges as published on ${fetchedOn}`, ...ranges.map((r) => `set_real_ip_from ${r};`), "real_ip_header CF-Connecting-IP;"]
  return {
    ok: true,
    rendered: {
      template: "cloudflare-real-ip",
      lines,
      checks: [{ label: "the home page answers as before", path: "/", expect: "same-as-before" }],
      notes: ["From now on the access log shows visitors' own addresses instead of Cloudflare's; that can only be seen in the log, not checked from outside."],
    },
  }
}

export async function fetchCloudflareRanges(fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const [a, b] = await Promise.all(["https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"].map((u) => fetchImpl(u, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.text() : ""))))
    const list = `${a}\n${b}`.split(/\s+/).map((s) => s.trim()).filter(Boolean)
    return list.length ? list : null
  } catch {
    return null
  }
}

// ---- entry point -----------------------------------------------------------------------

export function render(fix: Fix, extra: { cloudflareRanges?: string[]; today?: string } = {}): RenderResult {
  switch (fix.template) {
    case "deny-paths":
    case "gone-paths":
      return pathTemplate(fix.template, fix.params)
    case "block-user-agent":
      return blockUserAgent(fix.params)
    case "cloudflare-real-ip":
      if (!extra.cloudflareRanges) return { ok: false, message: "Cloudflare's published ranges couldn't be fetched" }
      return cloudflareRealIp(extra.cloudflareRanges, extra.today ?? new Date().toISOString().slice(0, 10))
    default:
      return { ok: false, message: `Samurai has no template named ${fix.template}` }
  }
}

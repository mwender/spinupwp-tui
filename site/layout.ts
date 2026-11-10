// The frame every page on spinuptui.com shares: head, nav and footer. Styles are
// in site.css, copied to /assets/site.css by build.ts.

export const REPO = "https://github.com/mwender/spinupwp-tui"
export const ORIGIN = "https://spinuptui.com"

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

// "2026-11-10" or an ISO timestamp → "November 10, 2026", in UTC so a release
// published late in the evening doesn't show the next day's date.
export const longDate = (d: string) => new Date(d.length === 10 ? `${d}T12:00:00Z` : d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })

type Section = "home" | "changelog" | "news"

const FAVICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 1 15 8 8 15 1 8z' fill='%2300d18f'/></svg>"

export function head(o: { title: string; description: string; path: string; ogTitle?: string; type?: "website" | "article" }): string {
  const url = ORIGIN + o.path
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${url}">
<meta property="og:site_name" content="SpinupTUI">
<meta property="og:title" content="${esc(o.ogTitle ?? o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:image" content="${ORIGIN}/assets/og.png?v=2">
<meta property="og:image:width" content="2400">
<meta property="og:image:height" content="1260">
<meta property="og:image:alt" content="SpinupTUI: your SpinupWP fleet, from the terminal.">
<meta property="og:type" content="${o.type ?? "website"}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${ORIGIN}/assets/og.png?v=2">
<meta name="theme-color" content="#0d1117">
<link rel="icon" href="${FAVICON}">
<link rel="alternate" type="application/atom+xml" title="SpinupTUI news and releases" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>`
}

export function nav(here: Section): string {
  const cur = (s: Section) => (s === here ? ` class="here" aria-current="page"` : "")
  return `<nav><div class="wrap">
  <a class="logo" href="/">◆ SpinupTUI</a>
  <a href="/#tour" class="hide-sm">Tour</a>
  <a href="/#modules">Modules</a>
  <a href="/news/"${cur("news")}>News</a>
  <a href="/changelog/"${cur("changelog")}>Changelog</a>
  <a href="${REPO}">GitHub</a>
</div></nav>`
}

export const footer = `<footer><div class="wrap">
  <span>◆ SpinupTUI</span>
  <a href="${REPO}">GitHub</a>
  <a href="${REPO}#readme">Docs</a>
  <a href="/news/">News</a>
  <a href="/changelog/">Changelog</a>
  <a href="/feed.xml">Feed</a>
  <span class="note">Built with OpenTUI and Bun. An independent project, not affiliated with SpinupWP or Delicious Brains.</span>
</div></footer>`

// A whole subpage: the shared head, nav and footer around a page heading and body.
export function page(o: { title: string; description: string; path: string; section: Section; heading: string; lede?: string; body: string; type?: "website" | "article" }): string {
  return `${head({ title: o.title, description: o.description, path: o.path, type: o.type })}
${nav(o.section)}

<header class="page-head"><div class="wrap narrow">
  ${o.heading}
  ${o.lede ? `<p class="lede">${o.lede}</p>` : ""}
</div></header>

<main class="page"><div class="wrap narrow">
${o.body}
</div></main>

${footer}
</body>
</html>
`
}

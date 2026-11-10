// Builds spinuptui.com into site/dist: the landing page, the news posts in
// site/posts, and the changelog, built from the GitHub release notes. Module
// cards take their copy from src/modules, the same lines the Modules tab shows,
// so the app and the site can't drift. Run: bun run site:build
// (SITE_DRAFTS=1 to include draft posts, for a local preview.)

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { MODULES, UPCOMING_MODULES } from "../src/modules/index.ts"
import pkg from "../package.json"
import { esc, footer, head, longDate, nav, ORIGIN, page, REPO } from "./layout.ts"
import { loadPosts, type Post } from "./news.ts"
import { fetchReleases, slugOf, type Release } from "./releases.ts"

const ROOT = join(import.meta.dir, "..")
const OUT = join(import.meta.dir, "dist")
const DOCS = `${REPO}/blob/main/docs`

const nameOf = (id: string) => [...MODULES, ...UPCOMING_MODULES].find((m) => m.id === id)?.name ?? id

// Stable releases only: a pre-release version shouldn't be the one the page
// advertises. Until then the modules, which only exist in the pre-release, say so.
const version = pkg.version.includes("-") ? null : pkg.version

const posts = loadPosts()
const releases = await fetchReleases()

// The hero's pill announces the newest post, if there is one, or else the modules.
const latest = posts[0]
const pill = latest
  ? `New: <a href="/news/${latest.slug}/">${esc(latest.title.replace(/^SpinupTUI [\d.]+:\s*/, ""))}</a>`
  : `New${version ? "" : " in pre-release"}: <a href="#modules">Sentinel, Beacon and Scheduler</a>`

const GLYPH: Record<string, string> = { beacon: "◉", scheduler: "◷", sentinel: "◈", samurai: "⟁" }

const card = (m: { id: string; name: string; summary: string; dependsOn: string[] }, coming: boolean) => `
      <article class="card${coming ? " coming" : ""}">
        <div class="card-head">
          <span class="glyph" aria-hidden="true">${GLYPH[m.id] ?? "◆"}</span>
          <h3>${esc(m.name)}</h3>
          ${coming ? `<span class="tag">Coming soon</span>` : ""}
        </div>
        <p>${esc(m.summary)}</p>
        <div class="card-foot">
          <span class="needs">${m.dependsOn.length ? `Needs ${m.dependsOn.map(nameOf).join(" + ")}` : "Needs nothing else"}</span>
          ${coming ? "" : `<a href="${DOCS}/${m.id}.md">Docs →</a>`}
        </div>
      </article>`

// Sentinel first: it's the headline, and the other two exist to serve it.
const ORDER = ["sentinel", "beacon", "scheduler"]
const shipped = [...MODULES].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
const cards = [...shipped.map((m) => card(m, false)), ...UPCOMING_MODULES.map((m) => card(m, true))].join("")

// The hero's mock fleet: example names only.
const FLEET: [string, number, number][] = [
  ["web1.example.net", 14, 41],
  ["web2.example.net", 9, 58],
  ["shop.example.com", 3, 76],
  ["web3.example.net", 21, 33],
  ["staging.example.net", 6, 22],
  ["web4.example.net", 11, 47],
]
const DOWN = 2 // the row that goes down in the hero's loop

const shot = (file: string, alt: string, cls = "") =>
  `<a class="shot ${cls}" href="/assets/${file}"><img src="/assets/${file}" alt="${esc(alt)}" loading="lazy" width="3840" height="2110"></a>`

const html = `${head({ title: "SpinupTUI — your SpinupWP fleet, from the terminal", ogTitle: "Your SpinupWP fleet, from the terminal", description: "A fast, keyboard-driven terminal control center for SpinupWP, with modules that watch your fleet, page you, and follow up after you close it.", path: "/" })}
${nav("home")}

<header class="hero"><div class="wrap">
  <div>
  <p class="pill"><span class="dot"></span>${pill}</p>
  <h1>Your <span class="g">SpinupWP</span> fleet,<br>from the terminal.</h1>
  <p class="lede">Every server and site in one fast, keyboard-driven app. Plus modules that keep watch after you close it: they work out what broke, page you, and follow up on their own.</p>
  <div class="install">
    <div class="tabs" role="tablist" aria-label="Install with">
      <button role="tab" aria-selected="true" data-cmd="brew install mwender/tap/spinuptui">Homebrew</button>
      <button role="tab" aria-selected="false" data-cmd="bun add -g spinuptui">Bun</button>
    </div>
    <div class="cmd"><code id="cmd">brew install mwender/tap/spinuptui</code><button class="copy" id="copy" type="button">copy</button></div>
  </div>
  <p class="meta">${version ? `v${version} · ` : ""}MIT · then run <code>spinuptui</code> and paste a <a href="https://spinupwp.com">SpinupWP</a> API token</p>
  </div>
  <div class="fleet" aria-hidden="true">
    <div class="win">
      <div class="win-bar"><i></i><i></i><i></i><span>spinuptui</span></div>
      <div class="win-tabs"><b>1 Dashboard</b><span>2 Servers</span><span>6 Modules</span></div>
      <div class="win-head"><span></span><span>Server</span><span>Sites</span><span>Disk</span></div>
      ${FLEET.map(([name, sites, disk]) => `<div class="row"><span class="st">●</span><span class="name">${name}</span><span class="n">${sites}</span><span class="bar${disk > 70 ? " warn" : ""}"><span style="--w:${disk}%"></span></span></div>`).join("\n      ")}
      <div class="win-foot"><span>${FLEET.length} servers · ${FLEET.reduce((n, [, s]) => n + s, 0)} sites</span><span class="watch">◈ Sentinel watching</span></div>
    </div>
    <div class="toast" id="toast"><small>Beacon</small><span id="toast-text"></span></div>
  </div>
</div></header>

<section id="tour"><div class="wrap">
  <p class="eyebrow">The app</p>
  <h2>See the whole fleet. Act on any of it.</h2>
  <p class="sub">A dashboard for everything SpinupWP knows, and the actions it doesn't have: live server health, plugin inventories, local copies, database pulls and DNS moves, one key away.</p>
  <div class="gallery">
    ${shot("screenshot-dashboard.png", "SpinupTUI dashboard", "wide")}
    ${shot("screenshot-servers.png", "Servers and sites browser")}
    ${shot("screenshot-stacks.png", "Stack detection and fleet composition")}
    ${shot("screenshot-search.png", "Global search")}
    ${shot("screenshot-events.png", "Events feed")}
  </div>
  <ul class="features">
    <li><b>Fleet dashboard.</b> Disk, pending reboots and upgrades, WordPress updates, end-of-life Ubuntu.</li>
    <li><b>Live server health.</b> CPU, load, memory and disk over SSH, in real time.</li>
    <li><b>Stack detection.</b> Standard WordPress, Bedrock or Radicle, with a PHP-version breakdown.</li>
    <li><b>Local copies.</b> Clone a site from production, pull its database, load missing media.</li>
    <li><b>Updates.</b> Change PHP versions and update WordPress core, one site or a whole group.</li>
    <li><b>DNS moves.</b> See a site's hosting records and repoint it to another server.</li>
  </ul>
</div></section>

<section id="modules"><div class="wrap">
  <p class="eyebrow">Modules</p>
  <h2>The part that keeps working after you quit.</h2>
  <p class="sub">Modules ship inside SpinupTUI. Turn them on from the Modules tab: each shows what it will change before it changes anything.${version ? "" : ` They're in pre-release for now: <code>bun add -g spinuptui@next</code>.`}</p>
  <div class="cards">${cards}
  </div>
</div></section>

<section id="headless"><div class="wrap headless">
  <div>
    <p class="eyebrow">Runs headless</p>
    <h2>Give it a machine. Walk away.</h2>
    <p class="sub">Any always-on Mac can be a station: it runs the modules on a schedule, unattended, and tells you only what needs you.</p>
    <ol class="steps">
      <li><b>Install it on the always-on machine</b>SSH in and run <code>spinuptui</code> there, the same app as on your laptop.</li>
      <li><b>Turn on Beacon, Scheduler and Sentinel</b>Connect your pager and your uptime monitors from the Modules tab. Each step checks itself before it's done.</li>
      <li><b>Get the why, not just the what</b>When a site goes down, you get the page, then the diagnosis, with the full report filed where your team works.</li>
    </ol>
  </div>
  <div class="phone" aria-label="Example pages from Sentinel">
    <div class="phone-head"><span class="dot"></span>SpinupTUI · Beacon</div>
    <div class="msg">🔴 shop.example.com down <span class="k">(http)</span> on web2: diagnosing.<time>09:41</time></div>
    <div class="msg">🧾 shop.example.com: A plugin update left a fatal error in checkout. Rolling the plugin back clears it.<br><span class="k">Report:</span> sites/shop.example.com/incidents/…<time>09:43</time></div>
  </div>
</div></section>

${footer}

<script>
  const cmd = document.getElementById("cmd"), copy = document.getElementById("copy")
  const tabs = [...document.querySelectorAll(".tabs button")]
  tabs.forEach((t) => t.addEventListener("click", () => {
    tabs.forEach((x) => x.setAttribute("aria-selected", String(x === t)))
    cmd.textContent = t.dataset.cmd
  }))
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(cmd.textContent); copy.textContent = "copied" } catch { copy.textContent = "select it" }
    setTimeout(() => (copy.textContent = "copy"), 1500)
  })
  // Hero loop: the cursor walks the fleet, one server goes down, Beacon pages,
  // then the diagnosis lands and the server recovers.
  const rows = [...document.querySelectorAll(".fleet .row")]
  const toast = document.getElementById("toast"), toastText = document.getElementById("toast-text")
  const down = rows[${DOWN}], site = down.querySelector(".name").textContent
  const pages = [
    "🔴 " + site + " down (http): diagnosing.",
    "🧾 " + site + ": a plugin update left a fatal error in checkout. Report filed.",
  ]
  const select = (r) => rows.forEach((x) => x.classList.toggle("sel", x === r))
  const show = (i) => { toastText.textContent = pages[i]; toast.classList.add("show"); toast.classList.toggle("done", i === 1) }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    select(rows[0]); show(1)
  } else {
    const steps = [
      [0, () => { toast.classList.remove("show"); down.classList.remove("down"); select(rows[0]) }],
      [900, () => select(rows[1])],
      [1800, () => { down.classList.add("down"); select(down); show(0) }],
      [5000, () => { show(1); down.classList.remove("down") }],
      [9500, () => select(rows[3])],
    ]
    const run = () => steps.forEach(([t, f]) => setTimeout(f, t))
    run(); setInterval(run, 11000)
  }
</script>
</body>
</html>
`

// ---- Changelog ---------------------------------------------------------------

const PER_PAGE = 10
const releaseHref = (r: Release) => `/changelog/${slugOf(r.tag)}/`

const entry = (r: Release, linked: boolean) => `<article class="entry" id="${esc(slugOf(r.tag))}">
  <div class="entry-head">
    <span class="ver">${esc(r.tag)}</span>
    <h2>${linked ? `<a href="${releaseHref(r)}">${esc(r.name)}</a>` : esc(r.name)}</h2>
    <span class="when">${longDate(r.date)}</span>
  </div>
  <div class="prose">${r.html}</div>
  <p class="entry-foot"><a href="${esc(r.url)}">View on GitHub →</a></p>
</article>`

const pageHref = (n: number) => (n === 1 ? "/changelog/" : `/changelog/page/${n}/`)
const pageCount = Math.max(1, Math.ceil(releases.length / PER_PAGE))
const pager = (n: number) => `<nav class="pager" aria-label="Changelog pages">
  <span>${n > 1 ? `<a href="${pageHref(n - 1)}">← Newer</a>` : ""}</span>
  <span class="pages">${Array.from({ length: pageCount }, (_, i) => i + 1).map((i) => (i === n ? `<b aria-current="page">${i}</b>` : `<a href="${pageHref(i)}">${i}</a>`)).join("")}</span>
  <span>${n < pageCount ? `<a href="${pageHref(n + 1)}">Older →</a>` : ""}</span>
</nav>`

const changelogPages = Array.from({ length: pageCount }, (_, i) => {
  const n = i + 1
  const slice = releases.slice(i * PER_PAGE, n * PER_PAGE)
  return {
    path: pageHref(n),
    html: page({
      title: n === 1 ? "Changelog — SpinupTUI" : `Changelog, page ${n} — SpinupTUI`,
      description: "What changed in each SpinupTUI release, newest first.",
      path: pageHref(n),
      section: "changelog",
      heading: `<p class="eyebrow">Changelog</p><h1>What's new in SpinupTUI</h1>`,
      lede: n === 1 ? `Every release, newest first. The full technical record is in <a href="${REPO}/blob/main/CHANGELOG.md">CHANGELOG.md</a>.` : `Page ${n} of ${pageCount}.`,
      body: slice.map((r) => entry(r, true)).join("\n") + pager(n),
    }),
  }
})

const releasePages = releases.map((r) => {
  const post = posts.find((p) => p.release === r.tag)
  return {
    path: releaseHref(r),
    html: page({
      title: `SpinupTUI ${r.tag}${r.name !== r.tag ? `: ${r.name}` : ""}`,
      description: `Release notes for SpinupTUI ${r.tag}.`,
      path: releaseHref(r),
      section: "changelog",
      type: "article",
      heading: `<p class="eyebrow"><a href="/changelog/">Changelog</a></p><h1>${esc(r.tag)}</h1>`,
      lede: `${esc(r.name !== r.tag ? r.name : "")}${r.name !== r.tag ? " · " : ""}${longDate(r.date)}${post ? ` · <a href="/news/${post.slug}/">Read the announcement</a>` : ""}`,
      body: `<div class="prose">${r.html}</div><p class="entry-foot"><a href="${esc(r.url)}">View on GitHub →</a></p>`,
    }),
  }
})

// ---- News ----------------------------------------------------------------------

const newsIndex = page({
  title: "News — SpinupTUI",
  description: "Announcements for notable SpinupTUI releases.",
  path: "/news/",
  section: "news",
  heading: `<p class="eyebrow">News</p><h1>News</h1>`,
  lede: `The story behind notable releases. Every release is in the <a href="/changelog/">changelog</a>.`,
  body: posts.length
    ? `<ul class="posts">${posts.map((p) => `<li><p class="post-meta">${longDate(p.date)}${p.release ? ` · ${esc(p.release)}` : ""}${p.draft ? " · draft" : ""}</p><h2><a href="/news/${p.slug}/">${esc(p.title)}</a></h2><p>${esc(p.summary)}</p><a href="/news/${p.slug}/">Read more →</a></li>`).join("")}</ul>`
    : `<p class="sub">Nothing here yet.</p>`,
})

const postPage = (p: Post) => {
  const rel = p.release ? releases.find((r) => r.tag === p.release) : undefined
  return page({
    title: `${p.title} — SpinupTUI`,
    description: p.summary,
    path: `/news/${p.slug}/`,
    section: "news",
    type: "article",
    heading: `<p class="eyebrow"><a href="/news/">News</a></p><h1>${esc(p.title)}</h1>`,
    lede: `${longDate(p.date)}${p.draft ? " · draft" : ""}`,
    body: `<article class="prose">${p.html}</article>
<aside class="post-cta"><p><b>The details:</b> ${rel ? `<a href="${releaseHref(rel)}">${esc(rel.tag)} release notes</a> · ` : ""}<a href="/changelog/">every release</a> · <a href="${REPO}#readme">docs</a></p></aside>`,
  })
}

// ---- Feed ------------------------------------------------------------------------

// One Atom feed for both: posts and stable releases, newest first.
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const feedItems = [
  ...posts.map((p) => ({ id: `${ORIGIN}/news/${p.slug}/`, title: p.title, updated: `${p.date}T12:00:00Z`, html: p.html })),
  ...releases.slice(0, 20).map((r) => ({ id: `${ORIGIN}${releaseHref(r)}`, title: `SpinupTUI ${r.tag}${r.name !== r.tag ? `: ${r.name}` : ""}`, updated: new Date(r.date).toISOString(), html: r.html })),
].sort((a, b) => b.updated.localeCompare(a.updated))
const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>SpinupTUI</title>
  <subtitle>News and releases</subtitle>
  <link href="${ORIGIN}/feed.xml" rel="self"/>
  <link href="${ORIGIN}/"/>
  <id>${ORIGIN}/</id>
  <updated>${feedItems[0]?.updated ?? new Date().toISOString()}</updated>
  <author><name>SpinupTUI</name></author>
${feedItems.map((e) => `  <entry>
    <title>${xml(e.title)}</title>
    <link href="${e.id}"/>
    <id>${e.id}</id>
    <updated>${e.updated}</updated>
    <content type="html">${xml(e.html)}</content>
  </entry>`).join("\n")}
</feed>
`

// ---- Write it out ------------------------------------------------------------------

const write = (path: string, body: string) => {
  const file = join(OUT, path.endsWith("/") ? `${path}index.html` : path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, "assets"), { recursive: true })
cpSync(join(import.meta.dir, "og.png"), join(OUT, "assets", "og.png"))
for (const f of ["screenshot-dashboard.png", "screenshot-servers.png", "screenshot-stacks.png", "screenshot-search.png", "screenshot-events.png"]) {
  cpSync(join(ROOT, ".github/assets", f), join(OUT, "assets", f))
}
cpSync(join(import.meta.dir, "site.css"), join(OUT, "assets", "site.css"))
write("/", html)
for (const p of [...changelogPages, ...releasePages]) write(p.path, p.html)
write("/news/", newsIndex)
for (const p of posts) write(`/news/${p.slug}/`, postPage(p))
write("/feed.xml", feed)
// GitHub Pages: serve files as-is, no Jekyll pass.
writeFileSync(join(OUT, ".nojekyll"), "")
console.log(`site/dist built (${MODULES.length} modules, ${UPCOMING_MODULES.length} coming; ${releases.length} releases on ${pageCount} changelog pages; ${posts.length} posts${posts.some((p) => p.draft) ? ", drafts included" : ""})`)

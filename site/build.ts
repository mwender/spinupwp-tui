// Builds the landing page (spinuptui.com) into site/dist. Module cards take
// their copy from src/modules, the same lines the Modules tab shows, so the app
// and the site can't drift. Run: bun run site:build

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MODULES, UPCOMING_MODULES } from "../src/modules/index.ts"
import pkg from "../package.json"

const ROOT = join(import.meta.dir, "..")
const OUT = join(import.meta.dir, "dist")
const REPO = "https://github.com/mwender/spinupwp-tui"
const DOCS = `${REPO}/blob/main/docs`

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const nameOf = (id: string) => [...MODULES, ...UPCOMING_MODULES].find((m) => m.id === id)?.name ?? id

// Stable releases only: a pre-release version shouldn't be the one the page
// advertises. Until then the modules, which only exist in the pre-release, say so.
const version = pkg.version.includes("-") ? null : pkg.version

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
  `<a class="shot ${cls}" href="assets/${file}"><img src="assets/${file}" alt="${esc(alt)}" loading="lazy" width="3840" height="2110"></a>`

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SpinupTUI — your SpinupWP fleet, from the terminal</title>
<meta name="description" content="A fast, keyboard-driven terminal control center for SpinupWP, with modules that watch your fleet, page you, and follow up after you close it.">
<meta property="og:site_name" content="SpinupTUI">
<meta property="og:title" content="Your SpinupWP fleet, from the terminal">
<meta property="og:description" content="A keyboard-driven terminal app for your SpinupWP servers and sites, with modules that diagnose outages and page you.">
<meta property="og:image" content="https://spinuptui.com/assets/og.png?v=2">
<meta property="og:image:width" content="2400">
<meta property="og:image:height" content="1260">
<meta property="og:image:alt" content="SpinupTUI: your SpinupWP fleet, from the terminal.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://spinuptui.com/">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://spinuptui.com/assets/og.png?v=2">
<meta name="theme-color" content="#0d1117">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path d='M8 1 15 8 8 15 1 8z' fill='%2300d18f'/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0d1117; --bg-alt: #11161d; --panel: #161b22; --border: #30363d;
    --text: #e6edf3; --dim: #8b949e; --faint: #586069;
    --brand: #00d18f; --brand-dim: #0a8f64; --brand-deep: #0b3d2c; --sky: #5ec8ff; --bad: #f85149;
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    --sans: Inter, system-ui, -apple-system, sans-serif;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 var(--sans); -webkit-font-smoothing: antialiased; }
  a { color: var(--brand); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, pre, .mono { font-family: var(--mono); }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }

  nav { position: sticky; top: 0; z-index: 10; background: rgba(13,17,23,.85); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); }
  nav .wrap { display: flex; align-items: center; gap: 28px; height: 52px; font: 14px var(--mono); }
  nav .logo { color: var(--brand); font-weight: 700; margin-right: auto; }
  nav a:not(.logo) { color: var(--dim); }
  nav a:not(.logo):hover { color: var(--text); text-decoration: none; }

  .hero { position: relative; padding: 96px 0 88px; overflow: hidden; }
  .hero::before { content: ""; position: absolute; top: -160px; right: -200px; width: 900px; height: 760px; background: radial-gradient(closest-side, rgba(0,209,143,.16), transparent); pointer-events: none; }
  .hero::after { content: ""; position: absolute; inset: 0; background-image: radial-gradient(rgba(139,148,158,.13) 1px, transparent 1px); background-size: 22px 22px; mask-image: linear-gradient(180deg, #000 0%, transparent 85%); -webkit-mask-image: linear-gradient(180deg, #000 0%, transparent 85%); pointer-events: none; }
  .hero .wrap { position: relative; z-index: 1; display: grid; grid-template-columns: 2fr 1fr; gap: 64px; align-items: center; }
  .hero .wrap > * { min-width: 0; }
  .pill { display: inline-flex; align-items: center; gap: 8px; font: 13px var(--mono); color: var(--dim); border: 1px solid var(--border); background: rgba(22,27,34,.7); border-radius: 999px; padding: 5px 14px 5px 10px; margin-bottom: 26px; }
  .pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 8px var(--brand); }
  .pill a { color: var(--text); }
  h1 { font: 700 clamp(34px, 4.6vw, 58px)/1.06 var(--mono); letter-spacing: -.03em; margin: 0 0 22px; }
  h1 .g { background: linear-gradient(90deg, var(--brand), var(--sky)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lede { max-width: 600px; margin: 0 0 34px; color: var(--dim); font-size: 19px; }

  .install { max-width: 520px; background: var(--bg-alt); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .tabs { display: flex; border-bottom: 1px solid var(--border); font: 13px var(--mono); }
  .tabs button { all: unset; cursor: pointer; padding: 10px 16px; color: var(--dim); border-bottom: 2px solid transparent; }
  .tabs button[aria-selected="true"] { color: var(--brand); border-bottom-color: var(--brand); }
  .tabs button:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
  .cmd { display: flex; align-items: center; gap: 12px; padding: 16px; font: 15px var(--mono); }
  .cmd::before { content: "$"; color: var(--brand); }
  .cmd code { flex: 1; overflow-x: auto; white-space: nowrap; }
  .copy { all: unset; cursor: pointer; font: 12px var(--mono); color: var(--dim); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; }
  .copy:hover { color: var(--brand); border-color: var(--brand-dim); }
  .meta { margin-top: 14px; font: 13px var(--mono); color: var(--faint); }
  .meta a { color: var(--dim); }

  .fleet { position: relative; font: 12.5px/1.5 var(--mono); margin-bottom: 88px; }
  .win { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(0,209,143,.06), 0 0 60px rgba(0,209,143,.07); }
  .win-bar { display: flex; align-items: center; gap: 6px; padding: 10px 12px; background: var(--panel); border-bottom: 1px solid var(--border); color: var(--faint); }
  .win-bar i { width: 10px; height: 10px; border-radius: 50%; background: #3a4048; }
  .win-bar i:nth-child(1) { background: #f85149; } .win-bar i:nth-child(2) { background: #d29922; } .win-bar i:nth-child(3) { background: #3fb950; }
  .win-bar span { margin-left: 8px; }
  .win-tabs { display: flex; gap: 14px; padding: 7px 12px; border-bottom: 1px solid #1f262e; color: var(--faint); }
  .win-tabs b { color: var(--brand); font-weight: 600; }
  .win-head, .row { display: grid; grid-template-columns: 14px 1fr 34px 62px; gap: 8px; align-items: center; padding: 3px 12px; }
  .win-head { color: var(--faint); font-size: 11px; padding-top: 10px; text-transform: uppercase; letter-spacing: .06em; }
  .row { color: var(--text); transition: background .3s; }
  .row .n { color: var(--faint); text-align: right; }
  .row .st { color: var(--brand); transition: color .3s; }
  .row.sel { background: #1f6f53; }
  .row.sel .n { color: var(--text); }
  .row.down .st { color: var(--bad); }
  .row.down .name { color: var(--bad); }
  .bar { height: 6px; border-radius: 3px; background: #21262d; overflow: hidden; }
  .bar span { display: block; height: 100%; width: var(--w); background: linear-gradient(90deg, var(--brand-dim), var(--brand)); }
  .bar.warn span { background: linear-gradient(90deg, #9e7418, #d29922); }
  .win-foot { display: flex; justify-content: space-between; margin-top: 8px; padding: 7px 12px; border-top: 1px solid #1f262e; color: var(--faint); font-size: 11.5px; }
  .win-foot .watch { color: var(--brand); }
  .toast { position: absolute; left: -36px; right: 24px; bottom: -88px; background: rgba(22,27,34,.96); border: 1px solid var(--border); border-left: 3px solid var(--bad); border-radius: 10px; padding: 10px 12px; box-shadow: 0 18px 40px rgba(0,0,0,.5); opacity: 0; transform: translateY(10px); transition: opacity .4s, transform .4s, border-color .4s; }
  .toast.show { opacity: 1; transform: none; }
  .toast.done { border-left-color: var(--brand); }
  .toast small { display: block; color: var(--faint); font-size: 10.5px; margin-bottom: 2px; }

  section { padding: 72px 0; }
  section + section { border-top: 1px solid #1b222b; }
  .eyebrow { font: 600 13px var(--mono); color: var(--brand); letter-spacing: .08em; text-transform: uppercase; margin: 0 0 10px; }
  h2 { font: 700 clamp(24px, 3.4vw, 34px)/1.2 var(--mono); margin: 0 0 14px; letter-spacing: -.01em; }
  .sub { color: var(--dim); max-width: 680px; margin: 0 0 36px; font-size: 17px; }

  .gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .shot { display: block; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); transition: border-color .2s, transform .2s; }
  .shot:hover { border-color: var(--brand-dim); transform: translateY(-2px); }
  .shot img { display: block; width: 100%; height: auto; }
  .shot.wide { grid-column: 1 / -1; }

  .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px 32px; margin: 48px 0 0; padding: 0; list-style: none; }
  .features li { padding-left: 20px; position: relative; color: var(--dim); font-size: 15px; }
  .features li::before { content: "▸"; position: absolute; left: 0; color: var(--brand); }
  .features b { color: var(--text); font-weight: 600; }

  .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
  .card { background: linear-gradient(180deg, var(--panel), var(--bg-alt)); border: 1px solid var(--border); border-radius: 12px; padding: 24px; display: flex; flex-direction: column; transition: border-color .2s; }
  .card:hover { border-color: var(--brand-dim); }
  .card-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .glyph { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; background: var(--brand-deep); color: var(--brand); font-size: 18px; border: 1px solid rgba(0,209,143,.25); }
  .card h3 { font: 700 20px var(--mono); margin: 0; }
  .card p { margin: 0 0 20px; flex: 1; font-size: 16px; }
  .card-foot { display: flex; justify-content: space-between; align-items: center; font: 13px var(--mono); color: var(--faint); }
  .tag { margin-left: auto; font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--sky); border: 1px solid rgba(94,200,255,.35); border-radius: 999px; padding: 3px 10px; }
  .card.coming { border-style: dashed; background: transparent; }
  .card.coming .glyph { background: transparent; color: var(--dim); border-color: var(--border); }
  .card.coming p { color: var(--dim); }

  .headless { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: center; }
  .steps { list-style: none; padding: 0; margin: 0; counter-reset: s; }
  .steps li { counter-increment: s; position: relative; padding: 0 0 22px 48px; color: var(--dim); }
  .steps li::before { content: counter(s); position: absolute; left: 0; top: 0; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font: 700 14px var(--mono); color: var(--bg); background: var(--brand); }
  .steps b { display: block; color: var(--text); font-weight: 600; }
  .phone { background: var(--bg-alt); border: 1px solid var(--border); border-radius: 18px; padding: 18px; font: 13.5px/1.55 var(--mono); box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  .phone-head { display: flex; align-items: center; gap: 10px; padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--border); color: var(--dim); font-size: 12px; }
  .phone-head .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 8px var(--brand); }
  .msg { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
  .msg:last-child { margin-bottom: 0; }
  .msg time { display: block; color: var(--faint); font-size: 11px; margin-top: 4px; }
  .msg .k { color: var(--sky); }

  footer { border-top: 1px solid var(--border); padding: 36px 0 48px; color: var(--faint); font: 13px var(--mono); }
  footer .wrap { display: flex; flex-wrap: wrap; gap: 12px 28px; align-items: center; }
  footer a { color: var(--dim); }
  footer .note { flex-basis: 100%; }

  @media (max-width: 820px) {
    nav .wrap { gap: 16px; }
    nav .hide-sm { display: none; }
    .gallery, .cards, .headless { grid-template-columns: 1fr; }
    .features { grid-template-columns: 1fr; }
    .hero { padding: 48px 0 80px; }
    .hero .wrap { grid-template-columns: 1fr; gap: 48px; }
    .fleet { max-width: 420px; width: 100%; }
    h1 { font-size: 29px; }
    .lede { font-size: 17px; }
    .row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toast { left: 12px; right: 12px; }
  }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } .shot, .card, .row, .toast { transition: none; } }
</style>
</head>
<body>
<nav><div class="wrap">
  <a class="logo" href="#">◆ SpinupTUI</a>
  <a href="#tour" class="hide-sm">Tour</a>
  <a href="#modules">Modules</a>
  <a href="#headless" class="hide-sm">Headless</a>
  <a href="${REPO}">GitHub</a>
</div></nav>

<header class="hero"><div class="wrap">
  <div>
  <p class="pill"><span class="dot"></span>New${version ? "" : " in pre-release"}: <a href="#modules">Sentinel, Beacon and Scheduler</a></p>
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

<footer><div class="wrap">
  <span>◆ SpinupTUI</span>
  <a href="${REPO}">GitHub</a>
  <a href="${REPO}#readme">Docs</a>
  <a href="${REPO}/blob/main/CHANGELOG.md">Changelog</a>
  <a href="${REPO}/releases">Releases</a>
  <span class="note">Built with OpenTUI and Bun. An independent project, not affiliated with SpinupWP or Delicious Brains.</span>
</div></footer>

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

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, "assets"), { recursive: true })
cpSync(join(import.meta.dir, "og.png"), join(OUT, "assets", "og.png"))
for (const f of ["screenshot-dashboard.png", "screenshot-servers.png", "screenshot-stacks.png", "screenshot-search.png", "screenshot-events.png"]) {
  cpSync(join(ROOT, ".github/assets", f), join(OUT, "assets", f))
}
writeFileSync(join(OUT, "index.html"), html)
// GitHub Pages: serve files as-is, no Jekyll pass.
writeFileSync(join(OUT, ".nojekyll"), "")
console.log(`site/dist built (${MODULES.length} modules, ${UPCOMING_MODULES.length} coming)`)

// Generates the README banner SVG — a recreation of the app's boot/splash
// screen (the block-font SPINUP logo on a terminal window) using the app's own
// theme colors. Regenerate the SVG + PNG with:
//
//   bun run .github/assets/_generate-banner.ts
//   rsvg-convert -w 1600 .github/assets/banner.svg -o .github/assets/banner.png
//
// The PNG (rasterized once) is what the README references, so the box-drawing
// glyphs render identically for everyone regardless of their installed fonts.

const C = {
  bg: "#0d1117",
  bgAlt: "#161b22",
  border: "#232b36",
  brand: "#00d18f",
  brandDim: "#0a8f64",
  accent: "#5ec8ff",
  text: "#e6edf3",
  textDim: "#8b949e",
  textFaint: "#586069",
  good: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
}

// The SPINUP logo exactly as the OpenTUI "block" font renders it on the splash.
const LOGO = [
  "███████╗ ██████╗  ██╗ ███╗   ██╗ ██╗   ██╗ ██████╗",
  "██╔════╝ ██╔══██╗ ██║ ████╗  ██║ ██║   ██║ ██╔══██╗",
  "███████╗ ██████╔╝ ██║ ██╔██╗ ██║ ██║   ██║ ██████╔╝",
  "╚════██║ ██╔═══╝  ██║ ██║╚██╗██║ ██║   ██║ ██╔═══╝ ",
  "███████║ ██║      ██║ ██║ ╚████║ ╚██████╔╝ ██║     ",
  "╚══════╝ ╚═╝      ╚═╝ ╚═╝  ╚═══╝  ╚═════╝  ╚═╝     ",
]
const width = Math.max(...LOGO.map((l) => l.length))
const logo = LOGO.map((l) => l.padEnd(width, " "))

const W = 1000
const H = 360
const MONO = "'SFMono-Regular','SF Mono','Menlo','DejaVu Sans Mono','Liberation Mono',monospace"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const logoFont = 24
const logoLine = 25
const logoTop = 96
const logoTspans = logo
  .map((line, i) => `<tspan x="500" dy="${i === 0 ? 0 : logoLine}">${esc(line)}</tspan>`)
  .join("")

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${MONO}">
  <defs>
    <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.brand}"/>
      <stop offset="1" stop-color="${C.accent}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.6">
      <stop offset="0" stop-color="${C.brand}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${C.brand}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="round"><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14"/></clipPath>
  </defs>

  <!-- window -->
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${C.bg}" stroke="${C.border}"/>
  <g clip-path="url(#round)">
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#glow)"/>

    <!-- titlebar -->
    <rect x="0" y="0" width="${W}" height="40" fill="${C.bgAlt}"/>
    <line x1="0" y1="40" x2="${W}" y2="40" stroke="${C.border}"/>
    <circle cx="26" cy="20" r="6" fill="${C.bad}"/>
    <circle cx="46" cy="20" r="6" fill="${C.warn}"/>
    <circle cx="66" cy="20" r="6" fill="${C.good}"/>
    <text x="90" y="25" font-size="13" fill="${C.textDim}">spinup — SpinupWP control center</text>

    <!-- logo -->
    <text y="${logoTop}" font-size="${logoFont}" font-weight="700" text-anchor="middle"
          fill="url(#logoGrad)" xml:space="preserve" letter-spacing="0">${logoTspans}</text>

    <!-- tagline + pulse -->
    <text x="500" y="278" font-size="17" text-anchor="middle" fill="${C.text}">Terminal control center for your SpinupWP fleet</text>
    <text x="500" y="300" font-size="13" text-anchor="middle" fill="${C.brandDim}" letter-spacing="2">· · • ● • · · · · · · ·</text>

    <!-- faux status bar (mirrors the real app chrome) -->
    <rect x="0" y="${H - 30}" width="${W}" height="30" fill="${C.bgAlt}"/>
    <line x1="0" y1="${H - 30}" x2="${W}" y2="${H - 30}" stroke="${C.border}"/>
    <text x="20" y="${H - 10}" font-size="13" xml:space="preserve"><tspan fill="${C.brand}">◆ SpinupWP</tspan><tspan fill="${C.textDim}">     1 Dashboard    2 Servers    3 Search    4 Events</tspan></text>
    <text x="${W - 20}" y="${H - 10}" font-size="13" text-anchor="end" fill="${C.textDim}">20 servers · 171 sites</text>
  </g>
</svg>
`

await Bun.write(new URL("./banner.svg", import.meta.url), svg)
console.log("wrote banner.svg")

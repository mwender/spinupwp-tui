// Generates the README banner SVG — a recreation of the app's boot/splash
// screen using the app's own theme colors. Regenerate the SVG + PNG with:
//
//   bun run .github/assets/_generate-banner.ts
//   rsvg-convert -w 1600 .github/assets/banner.svg -o .github/assets/banner.png
//
// The "SPINUP" wordmark is drawn as a vector block-font (filled <rect> cells),
// NOT as text — box-drawing glyphs don't rasterize reliably across fonts, so we
// render the blocks ourselves for a crisp, identical result everywhere.

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

// 5-row block font. "1" = filled cell. Columns vary per letter.
const GLYPHS: Record<string, string[]> = {
  S: ["11111", "10000", "11111", "00001", "11111"],
  P: ["11111", "10001", "11111", "10000", "10000"],
  I: ["111", "010", "010", "010", "111"],
  N: ["10001", "11001", "10101", "10011", "10001"],
  U: ["10001", "10001", "10001", "10001", "11111"],
}
const WORD = "SPINUP"

const W = 1000
const H = 360
const MONO = "'SFMono-Regular','SF Mono','Menlo','DejaVu Sans Mono','Liberation Mono',monospace"

// --- Lay out the block logo --------------------------------------------------
const CELL = 22 // px per block cell
const LETTER_GAP = 1 // cells between letters
const rows = 5
const colsFor = (ch: string) => GLYPHS[ch][0].length
const totalCols = WORD.split("").reduce((n, ch, i) => n + colsFor(ch) + (i > 0 ? LETTER_GAP : 0), 0)
const logoW = totalCols * CELL
const logoH = rows * CELL
const logoX = Math.round((W - logoW) / 2)
const logoY = 84

const rects: string[] = []
{
  let colCursor = 0
  for (let li = 0; li < WORD.length; li++) {
    const ch = WORD[li]
    const glyph = GLYPHS[ch]
    if (li > 0) colCursor += LETTER_GAP
    for (let r = 0; r < rows; r++) {
      const rowBits = glyph[r]
      for (let c = 0; c < rowBits.length; c++) {
        if (rowBits[c] === "1") {
          const x = logoX + (colCursor + c) * CELL
          const y = logoY + r * CELL
          rects.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="url(#logoGrad)"/>`)
        }
      }
    }
    colCursor += colsFor(ch)
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${MONO}">
  <defs>
    <linearGradient id="logoGrad" gradientUnits="userSpaceOnUse" x1="${logoX}" y1="${logoY}" x2="${logoX + logoW}" y2="${logoY + logoH}">
      <stop offset="0" stop-color="${C.brand}"/>
      <stop offset="1" stop-color="${C.accent}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.4" r="0.6">
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

    <!-- logo (vector block font) -->
    ${rects.join("\n    ")}

    <!-- tagline + pulse -->
    <text x="500" y="248" font-size="17" text-anchor="middle" fill="${C.text}">Terminal control center for your SpinupWP fleet</text>
    <text x="500" y="272" font-size="13" text-anchor="middle" fill="${C.brandDim}" letter-spacing="2">· · • ● • · · · · · · ·</text>

    <!-- faux status bar (mirrors the real app chrome) -->
    <rect x="0" y="${H - 30}" width="${W}" height="30" fill="${C.bgAlt}"/>
    <line x1="0" y1="${H - 30}" x2="${W}" y2="${H - 30}" stroke="${C.border}"/>
    <text x="20" y="${H - 10}" font-size="13" xml:space="preserve"><tspan fill="${C.brand}">◆ SpinupWP</tspan><tspan fill="${C.textDim}">     1 Dashboard    2 Servers    3 Search    4 Events</tspan></text>
    <text x="${W - 20}" y="${H - 10}" font-size="13" text-anchor="end" fill="${C.textDim}">20 servers · 171 sites</text>
  </g>
</svg>
`

await Bun.write(new URL("./banner.svg", import.meta.url), svg)
console.log(`wrote banner.svg (logo ${totalCols} cols × ${rows} rows, ${logoW}×${logoH}px)`)

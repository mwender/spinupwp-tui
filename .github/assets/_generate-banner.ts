// Generates the repo's brand images from the app's boot/splash aesthetic, using
// the app's own theme colors. Two outputs:
//
//   banner.{svg,png}          README header  (1000×360, ~2.78:1)
//   social-preview.{svg,png}  GitHub social preview (1280×640, 2:1)
//
// Regenerate both with:
//   bun run .github/assets/_generate-banner.ts
//   rsvg-convert -w 1600 .github/assets/banner.svg         -o .github/assets/banner.png
//   rsvg-convert -w 1280 .github/assets/social-preview.svg -o .github/assets/social-preview.png
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
  T: ["11111", "00100", "00100", "00100", "00100"],
}
const WORD = "SPINUPTUI"
const ROWS = 5
const LETTER_GAP = 1 // cells between letters
const MONO = "'SFMono-Regular','SF Mono','Menlo','DejaVu Sans Mono','Liberation Mono',monospace"

const colsFor = (ch: string) => GLYPHS[ch][0].length
const totalCols = WORD.split("").reduce((n, ch, i) => n + colsFor(ch) + (i > 0 ? LETTER_GAP : 0), 0)

// Emit the SPINUP wordmark as filled rects for a given cell size + top-left origin.
function logoRects(cell: number, logoX: number, logoY: number): string {
  const out: string[] = []
  let colCursor = 0
  for (let li = 0; li < WORD.length; li++) {
    const glyph = GLYPHS[WORD[li]]
    if (li > 0) colCursor += LETTER_GAP
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < glyph[r].length; c++) {
        if (glyph[r][c] === "1") {
          const x = logoX + (colCursor + c) * cell
          const y = logoY + r * cell
          out.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="url(#logoGrad)"/>`)
        }
      }
    }
    colCursor += colsFor(WORD[li])
  }
  return out.join("\n    ")
}

interface BuildOpts {
  W: number
  H: number
  cell: number
  titleH: number
  statusH: number
  logoY: number
  taglineY: number
  taglineSize: number
  pulseY: number
  featureLine?: { text: string; y: number; size: number }
}

function build(o: BuildOpts): string {
  const { W, H, cell, titleH, statusH } = o
  const logoW = totalCols * cell
  const logoH = ROWS * cell
  const logoX = Math.round((W - logoW) / 2)
  const cx = W / 2

  // Title-bar dots scaled to the bar height.
  const dotR = Math.round(titleH * 0.15)
  const dotGap = Math.round(dotR * 3.3)
  const dotX = Math.round(titleH * 0.65)
  const titleTextX = dotX + dotGap * 2 + 24
  const titleFont = Math.max(13, Math.round(titleH * 0.33))

  const statusY = H - Math.round(statusH * 0.33)
  const statusFont = Math.max(13, Math.round(statusH * 0.42))

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${MONO}">
  <defs>
    <linearGradient id="logoGrad" gradientUnits="userSpaceOnUse" x1="${logoX}" y1="${o.logoY}" x2="${logoX + logoW}" y2="${o.logoY + logoH}">
      <stop offset="0" stop-color="${C.brand}"/>
      <stop offset="1" stop-color="${C.accent}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.4" r="0.6">
      <stop offset="0" stop-color="${C.brand}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${C.brand}" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="round"><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14"/></clipPath>
  </defs>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${C.bg}" stroke="${C.border}"/>
  <g clip-path="url(#round)">
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#glow)"/>

    <!-- titlebar -->
    <rect x="0" y="0" width="${W}" height="${titleH}" fill="${C.bgAlt}"/>
    <line x1="0" y1="${titleH}" x2="${W}" y2="${titleH}" stroke="${C.border}"/>
    <circle cx="${dotX}" cy="${titleH / 2}" r="${dotR}" fill="${C.bad}"/>
    <circle cx="${dotX + dotGap}" cy="${titleH / 2}" r="${dotR}" fill="${C.warn}"/>
    <circle cx="${dotX + dotGap * 2}" cy="${titleH / 2}" r="${dotR}" fill="${C.good}"/>
    <text x="${titleTextX}" y="${titleH / 2 + titleFont * 0.36}" font-size="${titleFont}" fill="${C.textDim}">spinuptui — SpinupWP control center</text>

    <!-- logo (vector block font) -->
    ${logoRects(cell, logoX, o.logoY)}

    <!-- tagline + pulse -->
    <text x="${cx}" y="${o.taglineY}" font-size="${o.taglineSize}" text-anchor="middle" fill="${C.text}">Terminal control center for your SpinupWP fleet</text>
    <text x="${cx}" y="${o.pulseY}" font-size="${Math.round(o.taglineSize * 0.76)}" text-anchor="middle" fill="${C.brandDim}" letter-spacing="2">· · • ● • · · · · · · ·</text>
    ${o.featureLine ? `<text x="${cx}" y="${o.featureLine.y}" font-size="${o.featureLine.size}" text-anchor="middle" fill="${C.textDim}">${o.featureLine.text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>` : ""}

    <!-- faux status bar (mirrors the real app chrome) -->
    <rect x="0" y="${H - statusH}" width="${W}" height="${statusH}" fill="${C.bgAlt}"/>
    <line x1="0" y1="${H - statusH}" x2="${W}" y2="${H - statusH}" stroke="${C.border}"/>
    <text x="20" y="${statusY}" font-size="${statusFont}" xml:space="preserve"><tspan fill="${C.brand}">◆ SpinupTUI</tspan><tspan fill="${C.textDim}">   1 Dashboard   2 Servers   3 Stacks   4 Search   5 Events</tspan></text>
    <text x="${W - 20}" y="${statusY}" font-size="${statusFont}" text-anchor="end" fill="${C.textDim}">20 servers · 171 sites</text>
  </g>
</svg>
`
}

// README banner — wide and compact.
await Bun.write(
  new URL("./banner.svg", import.meta.url),
  build({ W: 1000, H: 360, cell: 16, titleH: 40, statusH: 30, logoY: 92, taglineY: 248, taglineSize: 17, pulseY: 272 }),
)

// GitHub social preview — 2:1, more vertical room + a feature line.
await Bun.write(
  new URL("./social-preview.svg", import.meta.url),
  build({
    W: 1280,
    H: 640,
    cell: 21,
    titleH: 50,
    statusH: 44,
    logoY: 195,
    taglineY: 420,
    taglineSize: 26,
    pulseY: 460,
    featureLine: {
      text: "Fleet dashboard · server & site browser · global search · live activity · htop-style health over SSH",
      y: 520,
      size: 17,
    },
  }),
)

console.log("wrote banner.svg and social-preview.svg")

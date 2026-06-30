// Centralized color palette + status helpers. Tweaking these restyles the whole app.
// SpinupWP's brand green anchors the theme.

export const theme = {
  brand: "#00d18f", // SpinupWP green
  brandDim: "#0a8f64",
  accent: "#5ec8ff", // sky blue for highlights/links
  text: "#e6edf3",
  textDim: "#8b949e",
  textFaint: "#586069",
  bg: "#0d1117",
  bgAlt: "#161b22",
  bgPanel: "#11161d",
  border: "#30363d",
  borderActive: "#00d18f",
  selectedBg: "#1f6f53",
  good: "#3fb950",
  warn: "#d29922",
  update: "#ffd23f", // bright gold — "new version available" nudge; brighter/cleaner than warn-amber so it reads as "new", not "caution"
  bad: "#f85149",
  info: "#5ec8ff",
  purple: "#bc8cff",
} as const

// Map an arbitrary status/connection string to a semantic color.
export function statusColor(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase()
  if (["connected", "deployed", "provisioned", "completed", "active", "success"].includes(s)) {
    return theme.good
  }
  if (["connecting", "provisioning", "deploying", "queued", "running", "pending", "in_progress"].includes(s)) {
    return theme.warn
  }
  if (["disconnected", "failed", "errored", "error", "offline"].includes(s)) {
    return theme.bad
  }
  return theme.textDim
}

// A small colored dot used throughout the UI to denote status at a glance.
export function statusDot(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase()
  if (["connected", "deployed", "provisioned", "completed", "active", "success"].includes(s)) return "●"
  if (["connecting", "provisioning", "deploying", "queued", "running", "pending", "in_progress"].includes(s)) return "◐"
  if (["disconnected", "failed", "errored", "error", "offline"].includes(s)) return "✕"
  return "○"
}

// Color a disk-usage percentage: green < 70, amber < 90, red otherwise.
export function diskColor(pct: number): string {
  if (pct < 70) return theme.good
  if (pct < 90) return theme.warn
  return theme.bad
}

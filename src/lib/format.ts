// Pure formatting helpers — bytes, dates, relative time, truncation, bars.

export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (bytes == null || isNaN(bytes)) return "—"
  if (bytes === 0) return "0 B"
  const k = 1000 // SpinupWP reports disk space in decimal (GB), so use base-1000
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  const value = bytes / Math.pow(k, i)
  return `${value.toFixed(i === 0 ? 0 : decimals)} ${sizes[i]}`
}

// Percentage of disk used (0–100). Returns 0 when unknown.
export function diskUsedPct(used?: number | null, total?: number | null): number {
  if (!total || total <= 0 || used == null) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}

// A unicode progress bar, e.g. ████████░░░░ for a given fraction.
export function bar(fraction: number, width = 12): string {
  const clamped = Math.min(1, Math.max(0, fraction))
  const filled = Math.round(clamped * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

// Human relative time, e.g. "3m ago", "2h ago", "5d ago".
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  const secs = Math.floor((Date.now() - d.getTime()) / 1000)
  if (secs < 0) return "soon"
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

// Compact uptime, e.g. "36d 5h", "5h 12m", "3m".
export function formatUptime(secs: number | null | undefined): string {
  if (!secs || secs < 0) return "—"
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

// Render a series (0..max) as a unicode sparkline of the most recent `width` points.
export function sparkline(values: number[], width = 30, max = 100): string {
  if (values.length === 0) return ""
  const recent = values.slice(-width)
  return recent
    .map((v) => {
      const frac = Math.min(1, Math.max(0, v / max))
      return SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.round(frac * (SPARK_CHARS.length - 1)))]
    })
    .join("")
}

// Truncate the MIDDLE, keeping the head and tail — for long paths/filenames where
// both ends matter (e.g. ".../app/sql/site_2026-06-22.sql.gz").
export function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 1) return s.slice(0, Math.max(0, max))
  const keep = max - 1 // room for the ellipsis
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return s.slice(0, head) + "…" + s.slice(s.length - tail)
}

export function truncate(s: string | null | undefined, max: number): string {
  if (!s) return ""
  if (s.length <= max) return s
  if (max <= 1) return s.slice(0, max)
  return s.slice(0, max - 1) + "…"
}

// Right-pad a string to a fixed visible width (for column alignment).
export function padEndVis(s: string, width: number): string {
  const len = s.length
  if (len >= width) return s
  return s + " ".repeat(width - len)
}

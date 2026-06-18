// Tier-1 site "stack" classification — pure functions over data we already
// fetch (no SSH, no extra API calls). Signals: `is_wordpress` and
// `public_folder` on the Site object, validated against the live fleet.
//
//   is_wordpress === false      → Non-WP
//   is_wordpress && "/web/"      → Bedrock
//   is_wordpress && anything else → Standard WP
//
// Important: `public_folder` is the user-set "Public Folder" (the suffix after
// `~/sites/{domain}/files`), NOT a SpinupWP-enforced stack flag. So this is a
// heuristic keyed on a convention: webroot `/web/` means Bedrock. The
// is_wordpress guard matters — a couple of non-WP custom apps also use "/web/",
// so Bedrock requires WP too. Any other WP webroot (incl. the bare `~/files`
// default, `/public/`, `/`) is treated as Standard WP. Tier-2 (on-demand SSH
// probe that inspects the filesystem) is the authoritative correction layer.

import type { Site } from "../api/types.ts"
import type { ProbeKind } from "./probe.ts"
import { theme } from "./theme.ts"

export type Stack = "Standard WP" | "Bedrock" | "Non-WP"

// All buckets in display order (kept stable so the Stacks view doesn't reflow).
export const STACKS: Stack[] = ["Standard WP", "Bedrock", "Non-WP"]

export function classifyStack(site: Site): Stack {
  if (!site.is_wordpress) return "Non-WP"
  if (site.public_folder === "/web/") return "Bedrock"
  return "Standard WP"
}

// The bucket a site actually belongs in once Tier-2 is considered. A CONCLUSIVE
// probe (positive identification) overrides the Tier-1 heuristic; an
// inconclusive ("unknown"), failed, or absent probe falls back to Tier-1. This
// is how an API-mislabeled site (is_wordpress=false but really WordPress) moves
// into its true bucket after `d`.
export function effectiveStack(site: Site, probeKind?: ProbeKind | null): Stack {
  switch (probeKind) {
    case "wordpress":
      return "Standard WP"
    case "bedrock":
      return "Bedrock"
    case "whmcs":
    case "laravel":
    case "static":
      return "Non-WP"
    default:
      return classifyStack(site)
  }
}

// `onSelection` brightens the colors that read poorly on the focused
// (bright-green) selection background (green-on-green Bedrock, the faint grey).
export function stackColor(stack: Stack, onSelection = false): string {
  switch (stack) {
    case "Standard WP":
      return theme.accent // blue
    case "Bedrock":
      return onSelection ? theme.text : theme.good // green
    case "Non-WP":
      return onSelection ? theme.text : theme.textDim // gray
  }
}

// Compact tag for tight one-line list rows.
export function stackTag(stack: Stack): string {
  switch (stack) {
    case "Standard WP":
      return "wp"
    case "Bedrock":
      return "bedrock"
    case "Non-WP":
      return "app"
  }
}

// PHP end-of-life check for the fleet PHP-version distribution. As of mid-2026,
// 8.0 and 8.1 are past end-of-life; 8.2+ still receive (security) support.
export function isPhpEol(version: string | null | undefined): boolean {
  if (!version) return false
  const [maj, min] = version.split(".").map((n) => Number.parseInt(n, 10))
  if (!Number.isFinite(maj)) return false
  if (maj < 8) return true
  return maj === 8 && (min ?? 0) <= 1
}

// Numeric sort key for "8.10" > "8.2" correctness (major*100 + minor).
export function phpSortKey(version: string | null | undefined): number {
  if (!version) return -1
  const [maj, min] = version.split(".").map((n) => Number.parseInt(n, 10))
  if (!Number.isFinite(maj)) return -1
  return maj * 100 + (Number.isFinite(min) ? min : 0)
}

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

// Which pull the clone wizard runs for a site — the SAME effectiveStack a
// probe corrects elsewhere (Stacks tab, Browser), so an API-mislabeled site
// (is_wordpress=false but really WordPress — e.g. lp.anchoredconstructiontn.com,
// northcoastmodern.com, verified live 2026-07-08) gets a real database pull
// once probed, instead of silently defaulting to a files-only copy. git.repo
// still takes precedence for Bedrock detection (the pull needs the repo URL,
// which a probe alone can't supply) — a probe saying "bedrock" without a
// connected repo can't actually be pulled as Bedrock, so it falls back to
// files-only rather than a wrong wp-stack pull.
export function cloneStackFor(site: Site, probeKind?: ProbeKind | null): "wp" | "bedrock" | "files" {
  if (site.git?.repo) return "bedrock"
  return effectiveStack(site, probeKind) === "Standard WP" ? "wp" : "files"
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

// PHP version helpers (EOL check, sort key) live in ./phpEol.ts — EOL is
// computed from real dates vs today, refreshed from endoflife.date.

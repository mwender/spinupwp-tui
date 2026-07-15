// Tier-1 site "stack" classification — pure functions over data we already
// fetch (no SSH, no extra API calls). Signals: `is_wordpress` and
// `public_folder` on the Site object, validated against the live fleet.
//
//   is_wordpress === false           → Non-WP
//   is_wordpress && webroot ends "web" → Bedrock
//   is_wordpress && anything else     → Standard WP
//
// Important: `public_folder` is the user-set "Public Folder" (the suffix after
// `~/sites/{domain}/files`), NOT a SpinupWP-enforced stack flag. So this is a
// heuristic keyed on a convention: a webroot named `web` means Bedrock — checked
// by its LAST path segment (not an exact "/web/" match), so a nested layout like
// `/site/web/` (the Bedrock project moved into a subdirectory — a real, seen
// layout, see the WP-core-detection fix in serverClone.ts) still buckets
// correctly instead of falling through to Standard WP. The is_wordpress guard
// matters — a couple of non-WP custom apps also use a `web` webroot, so Bedrock
// requires WP too. Any other WP webroot (incl. the bare `~/files` default,
// `/public/`, `/`) is treated as Standard WP. Tier-2 (on-demand SSH probe that
// inspects the filesystem) is the authoritative correction layer regardless.

import type { Site } from "../api/types.ts"
import type { ProbeKind } from "./probe.ts"
import { publicFolderRel } from "./serverClone.ts"
import { theme } from "./theme.ts"

export type Stack = "Standard WP" | "Bedrock" | "Radicle" | "Non-WP"

// All buckets in display order (kept stable so the Stacks view doesn't reflow).
export const STACKS: Stack[] = ["Standard WP", "Bedrock", "Radicle", "Non-WP"]

export function classifyStack(site: Site): Stack {
  if (!site.is_wordpress) return "Non-WP"
  const rel = publicFolderRel(site.public_folder ?? undefined) // e.g. "web" or "site/web"
  if (rel === "web" || rel.endsWith("/web")) return "Bedrock"
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
    case "radicle":
      // Radicle's public/ webroot is indistinguishable from a hardened
      // Standard-WP public/ layout at Tier-1 (public_folder alone), so this
      // bucket only exists once Tier-2 (SSH probe) confirms roots/acorn.
      return "Radicle"
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
// (is_wordpress=false but really WordPress — confirmed live against real
// client sites, 2026-07-08) gets a real database pull once probed, instead
// of silently defaulting to a files-only copy. git.repo still takes
// precedence for Bedrock detection (the pull needs the repo URL, which a
// probe alone can't supply) — is_wordpress is unreliable for git sites, so
// absent a probe (or a WP-family one) git.repo remains the best available
// signal. But git.repo alone only proves "deployed via git," not "is
// Bedrock" — a git-deployed STATIC site (confirmed live, 2026-07-09: a
// client's git-deployed static site, repo literally named
// "*-static-site") would otherwise be routed through a Bedrock pull
// (composer install, wp-cli) it can't survive. A CONCLUSIVE non-WordPress
// probe (whmcs/laravel/static) overrides git.repo; a probe saying
// "bedrock"/"wordpress", or no probe at all, still trusts git.repo.
export function cloneStackFor(site: Site, probeKind?: ProbeKind | null): "wp" | "bedrock" | "files" {
  if (site.git?.repo) {
    if (probeKind === "whmcs" || probeKind === "laravel" || probeKind === "static") return "files"
    return "bedrock"
  }
  // A "radicle" probe never falls into "wp" here since effectiveStack maps it
  // to "Radicle", not "Standard WP" — deliberate: the Standard-WP pull chain
  // assumes a flat webroot and would corrupt a Radicle clone. Real Radicle
  // clone-wizard support is a separate, not-yet-built phase (issue #38).
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
    case "Radicle":
      return onSelection ? theme.text : theme.purple
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
    case "Radicle":
      return "radicle"
    case "Non-WP":
      return "app"
  }
}

// PHP version helpers (EOL check, sort key) live in ./phpEol.ts — EOL is
// computed from real dates vs today, refreshed from endoflife.date.

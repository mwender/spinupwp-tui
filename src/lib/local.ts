// Local working-copy linking — Phase 1 (link + view, no mutation).
//
// Bridges SpinupWP's remote site inventory to the user's LOCAL dev copies so
// the TUI can later help with continued management (the Bedrock composer-update
// → push → auto-deploy loop). This module owns the link *shape* and the
// read-only validation of a configured link; it never mutates anything.
//
// A link is keyed by SpinupWP site id (stable across domain renames) and stores
// the local `path` plus an explicitly-captured `localUrl` (we don't guess it —
// the URL is recorded as entered, per the locked spec). `localUrl` is host-tool
// agnostic on purpose: it's whatever serves the local copy — Valet, Cove,
// LocalWP, Herd, DDEV, `artisan serve`, etc. We never assume a specific tool.

import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, readFileSync, readdirSync } from "node:fs"

export interface LocalLink {
  // Recorded for display / sanity-checking against the live site domain.
  domain: string
  // Local filesystem path to the working copy. Stored as entered (may use `~`);
  // expanded only at point of use so the config stays readable/portable.
  path: string
  // The URL where the local copy is served (e.g. https://example.test). Stored
  // explicitly, not derived, and tool-agnostic. May be empty.
  localUrl: string
}

// Normalize a stored link, tolerating older configs that used `valetUrl` before
// the field was generalized to `localUrl`. Reads either key; emits `localUrl`.
export function normalizeLink(raw: LocalLink & { valetUrl?: string }): LocalLink {
  return { domain: raw.domain, path: raw.path, localUrl: raw.localUrl ?? raw.valetUrl ?? "" }
}

// Resolution of a link against the filesystem, computed on demand (cheap — one
// focused site at a time). `kind` mirrors the stack buckets used elsewhere.
export type LocalKind = "bedrock" | "wp" | "unknown"
export interface LocalState {
  exists: boolean
  kind: LocalKind
  // Short human label for the detail field, e.g. "Bedrock" / "WordPress".
  label: string
}

// Expand a leading `~` to the user's home directory. Leaves other paths as-is.
export function expandPath(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

// Files that signal "a project root lives here" — used to locate the working
// copy and to read its git/.env. Deliberately marker-based (not folder-name
// based) so layouts like `app/`, `public/`, `web/` all work without hardcoding
// any one developer's convention.
function hasProjectMarkers(dir: string): boolean {
  return (
    existsSync(join(dir, "composer.json")) ||
    existsSync(join(dir, ".git")) ||
    existsSync(join(dir, ".env")) ||
    existsSync(join(dir, "wp-config.php")) ||
    existsSync(join(dir, "config", "application.php"))
  )
}

// Resolve the actual project root within a linked folder: the folder itself if
// it holds markers, else the first immediate subdirectory that does (so a
// domain folder containing the app in `app/`, `public/`, etc. resolves without
// us naming the convention). Read-only; never throws.
export function findProjectRoot(dir: string): string {
  if (hasProjectMarkers(dir)) return dir
  try {
    for (const child of readdirSync(dir)) {
      if (child.startsWith(".")) continue
      const c = join(dir, child)
      if (hasProjectMarkers(c)) return c
    }
  } catch {
    // unreadable — fall through to the folder itself
  }
  return dir
}

// Classify a local working copy by reading a few marker files (read-only):
//   Bedrock = composer.json requiring roots/bedrock, or config/application.php
//   WordPress = wp-config.php at the root (or a public/ webroot)
// Anything that exists but matches neither is "unknown".
function classify(dir: string): LocalKind {
  const composer = join(dir, "composer.json")
  if (existsSync(composer)) {
    try {
      if (readFileSync(composer, "utf8").includes("roots/bedrock")) return "bedrock"
    } catch {
      // unreadable composer.json — fall through to other markers
    }
  }
  if (existsSync(join(dir, "config", "application.php"))) return "bedrock"
  if (existsSync(join(dir, "wp-config.php")) || existsSync(join(dir, "public", "wp-config.php"))) return "wp"
  return "unknown"
}

const KIND_LABEL: Record<LocalKind, string> = {
  bedrock: "Bedrock",
  wp: "WordPress",
  unknown: "unrecognized",
}

// Validate a configured link against the local filesystem. Never throws. The
// stored path is the project *folder*; we classify at its detected root so a
// nested layout (app/, public/, …) still reports the right stack.
export function resolveLocalLink(link: LocalLink): LocalState {
  const dir = expandPath(link.path)
  if (!existsSync(dir)) return { exists: false, kind: "unknown", label: "missing" }
  const kind = classify(findProjectRoot(dir))
  return { exists: true, kind, label: KIND_LABEL[kind] }
}

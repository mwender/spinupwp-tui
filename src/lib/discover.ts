// Local working-copy auto-discovery — Phase 2.
//
// Given the user's configured scan roots (directories where they keep local
// copies), enumerate the immediate subdirectories and try to match each to a
// SpinupWP site, most-reliable signal first:
//   1. git remote   — local `.git/config` origin URL vs the site's `git.repo`
//   2. WP_HOME       — a Bedrock `.env`'s WP_HOME host vs the site's domain(s)
//   3. folder name   — the directory name vs the site's domain
// Read-only: we read a couple of small marker files, never write or run git.
// Matches to already-linked sites are skipped (this proposes *new* links).

import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { findProjectRoot } from "./local.ts"
import type { Site } from "../api/types.ts"

export type Confidence = "high" | "medium" | "low"

export interface Proposal {
  // Path as it will be stored on the link (root form preserved, e.g. with `~`).
  path: string
  site: Site
  reason: string
  confidence: Confidence
  // Local URL discovered from WP_HOME, if any — prefilled onto the link.
  localUrl?: string
}

export interface ScanResult {
  proposals: Proposal[]
  scannedDirs: number
}

function expand(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

// Normalize a git URL to `host/org/repo` (lowercased, no protocol/user/.git) so
// scp-style and https forms of the same repo compare equal.
export function normalizeGitUrl(url: string | null | undefined): string | null {
  if (!url) return null
  let s = url.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^ssh:\/\//, "").replace(/^https?:\/\//, "").replace(/^git@/, "")
  s = s.replace(/\.git$/, "")
  s = s.replace(":", "/") // scp-style host:org/repo → host/org/repo
  return s || null
}

// Pull the origin remote URL out of a local `.git/config` (no subprocess).
function gitOriginUrl(dir: string): string | null {
  const cfg = join(dir, ".git", "config")
  if (!existsSync(cfg)) return null
  try {
    const text = readFileSync(cfg, "utf8")
    // Find the [remote "origin"] section, then its first `url = …`.
    const m = text.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/)
    const url = m?.[1].match(/url\s*=\s*(.+)/)?.[1]
    return url?.trim() ?? null
  } catch {
    return null
  }
}

// Read WP_HOME from a Bedrock-style `.env`. Returns the full URL string.
function wpHome(dir: string): string | null {
  const env = join(dir, ".env")
  if (!existsSync(env)) return null
  try {
    const line = readFileSync(env, "utf8").match(/^\s*WP_HOME\s*=\s*(.+)$/m)?.[1]
    if (!line) return null
    return line.trim().replace(/^['"]|['"]$/g, "") || null
  } catch {
    return null
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase() || null
  } catch {
    return null
  }
}

// Every domain a site answers to (primary + additional), lowercased.
function siteDomains(site: Site): string[] {
  const out = [site.domain.toLowerCase()]
  for (const d of site.additional_domains ?? []) if (d.domain) out.push(d.domain.toLowerCase())
  return out
}

export async function scanRoots(roots: string[], sites: Site[], linkedSiteIds: Set<number>): Promise<ScanResult> {
  // Index unlinked sites by their matchable signals.
  const candidates = sites.filter((s) => !linkedSiteIds.has(s.id))
  const byGit = new Map<string, Site>()
  const byDomain = new Map<string, Site>()
  for (const s of candidates) {
    const g = normalizeGitUrl(s.git?.repo)
    if (g && !byGit.has(g)) byGit.set(g, s)
    for (const d of siteDomains(s)) if (!byDomain.has(d)) byDomain.set(d, s)
  }

  const proposals: Proposal[] = []
  const claimed = new Set<number>() // a site is proposed at most once
  let scannedDirs = 0

  for (const root of roots) {
    const abs = expand(root)
    let entries: string[]
    try {
      entries = await readdir(abs)
    } catch {
      continue // unreadable/missing root — skip
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue
      const absDir = join(abs, name)
      try {
        if (!(await stat(absDir)).isDirectory()) continue
      } catch {
        continue
      }
      scannedDirs++
      // Store the plain project folder (what the user recognizes; they cd from
      // there). Read the matching signals from its detected root, which may be a
      // nested subdir (app/, public/, …) — found by markers, not by name.
      const storedPath = join(root, name) // preserve the root's form (e.g. `~`)
      const projDir = findProjectRoot(absDir)
      const home = wpHome(projDir)
      const localUrl = home ?? undefined

      // 1) git remote
      const g = normalizeGitUrl(gitOriginUrl(projDir))
      let match: { site: Site; reason: string; confidence: Confidence } | null = null
      if (g && byGit.has(g)) {
        match = { site: byGit.get(g)!, reason: "git remote", confidence: "high" }
      } else if (home) {
        // 2) WP_HOME host
        const host = hostOf(home)
        if (host && byDomain.has(host)) match = { site: byDomain.get(host)!, reason: "WP_HOME", confidence: "high" }
      }
      // 3) folder name == a domain (or its first label)
      if (!match) {
        const base = name.toLowerCase()
        const site =
          byDomain.get(base) ?? candidates.find((s) => siteDomains(s).some((d) => d.split(".")[0] === base))
        if (site) match = { site, reason: "folder name", confidence: "low" }
      }

      if (match && !claimed.has(match.site.id)) {
        claimed.add(match.site.id)
        proposals.push({ path: storedPath, site: match.site, reason: match.reason, confidence: match.confidence, localUrl })
      }
    }
  }

  // Alphabetical by domain (the user scans this list by site name).
  proposals.sort((a, b) => a.site.domain.localeCompare(b.site.domain))
  return { proposals, scannedDirs }
}

// "What's new" notes for the version currently running, fetched once from
// GitHub's release for that exact tag — reuses the same API the update-checker
// (appUpdate.ts) already polls, so no new infrastructure (no spinuptui.com feed).
// Shown once via the ReleaseNotes overlay when store.tsx detects the running
// version hasn't been "seen" yet (config.lastSeenVersion).

import { REPO_SLUG } from "../version.ts"

const FETCH_TIMEOUT_MS = 5000

export interface ReleaseNotesInfo {
  version: string
  title: string
  body: string // raw markdown from the GitHub release body
  url: string
}

// Hit GitHub for one specific release's notes; null on any failure (offline, no
// release published yet for this tag, rate limit). Times out so it can't hang
// the launch. Unlike appUpdate.ts's "latest release" poll, this targets the
// EXACT running version's tag, so it's correct even if the user updates across
// several releases in one hop.
export async function fetchReleaseNotes(version: string): Promise<ReleaseNotesInfo | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases/tags/v${version}`, {
      headers: {
        "User-Agent": "spinup-tui",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as { name?: string; body?: string; html_url?: string }
    if (!json.body) return null
    return {
      version,
      title: json.name ?? `v${version}`,
      body: json.body,
      url: json.html_url ?? `https://github.com/${REPO_SLUG}/releases/tag/v${version}`,
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export type NoteLine = { kind: "heading" | "bullet" | "text" | "blank"; content: string }

// Strip GitHub-flavored markdown down to something readable as plain terminal
// text. Not a general markdown parser (no new dependency) — just enough for the
// shape of notes this project actually writes (see RELEASING.md's house style):
// an intro line, `##` section headers, `- ` bullets (often **bold**-led), a
// blank-line-separated Update/Full-changelog footer.
export function formatReleaseNotesBody(body: string): NoteLine[] {
  const strip = (s: string) => s.replace(/\*\*/g, "").replace(/`/g, "")
  return body.split("\n").map((raw): NoteLine => {
    const line = raw.trimEnd()
    if (line.trim() === "") return { kind: "blank", content: "" }
    if (line.startsWith("## ")) return { kind: "heading", content: strip(line.slice(3)) }
    if (line.startsWith("- ")) return { kind: "bullet", content: strip(line.slice(2)) }
    return { kind: "text", content: strip(line) }
  })
}

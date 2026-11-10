// The changelog pages are built from the GitHub release notes, the readable
// account of each release. CHANGELOG.md stays the detailed record in the repo.
// Stable releases only: pre-releases are on GitHub for anyone who wants them.

import { REPO } from "./layout.ts"

export type Release = { tag: string; name: string; date: string; url: string; html: string }

const API = "https://api.github.com/repos/mwender/spinupwp-tui/releases"

// CI passes the workflow's token. Locally, gh's login if there is one; the
// releases are public, so no token also works, within the anonymous rate limit.
async function token(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    const p = Bun.spawnSync(["gh", "auth", "token"], { stderr: "ignore" })
    const t = p.stdout.toString().trim()
    return p.exitCode === 0 && t ? t : null
  } catch {
    return null
  }
}

type ApiRelease = { tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string | null; draft: boolean; prerelease: boolean }

// A failed fetch fails the build: publishing a changelog with releases missing
// is worse than not deploying at all.
export async function fetchReleases(): Promise<Release[]> {
  const t = await token()
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "spinuptui-site-build" }
  if (t) headers.authorization = `Bearer ${t}`
  const all: ApiRelease[] = []
  for (let n = 1; n < 20; n++) {
    const res = await fetch(`${API}?per_page=100&page=${n}`, { headers })
    if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300))
    const batch = (await res.json()) as ApiRelease[]
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all
    .filter((r) => !r.draft && !r.prerelease && r.published_at)
    .sort((a, b) => b.published_at!.localeCompare(a.published_at!))
    .map((r) => ({ tag: r.tag_name, name: title(r), date: r.published_at!, url: r.html_url, html: render(trimBoilerplate(r.body ?? "")) }))
}

// Every release ends with the same "Update:" and "Full changelog:" lines. They
// belong on GitHub; on a page of ten releases they're noise, and "View on
// GitHub" is under each one anyway.
export const trimBoilerplate = (md: string) => md.replace(/^\*\*(Update|Full changelog):\*\*.*$/gim, "")

// Release titles are "v1.2.2 — Kuma behind proxies, …"; the page shows the
// version on its own, so keep only what follows it.
function title(r: ApiRelease): string {
  const name = (r.name ?? "").trim()
  const rest = name.replace(new RegExp(`^(spinupwp-tui\\s+)?${r.tag_name.replace(/\./g, "\\.")}\\s*(—|-|:)?\\s*`), "")
  return rest || name || r.tag_name
}

// GitHub links @user and #123 in release notes; Markdown doesn't, so do it here,
// outside code spans and blocks.
export function linkify(md: string): string {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/(^|[\s(])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/g, (_, pre, u) => `${pre}[@${u}](https://github.com/${u})`)
            .replace(/(^|[\s(])#(\d{1,5})\b/g, (_, pre, n) => `${pre}[#${n}](${REPO}/issues/${n})`),
    )
    .join("")
}

export function render(md: string): string {
  // Notes written for GitHub can carry HTML comments; drop them.
  const clean = md.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").trim()
  return Bun.markdown.html(linkify(clean), { autolinks: true } as never)
}

// "v1.3.0" → a path segment that's safe as a directory name.
export const slugOf = (tag: string) => tag.replace(/[^A-Za-z0-9._-]/g, "-")

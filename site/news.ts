// News posts: short, hand-written announcements for releases worth a story.
// Each is a Markdown file in site/posts/ with a front-matter block:
//
//   ---
//   title: SpinupTUI 1.3.0: modules that keep watch
//   date: 2026-11-12
//   summary: One or two sentences for the news index, the feed and link previews.
//   release: v1.3.0        (optional: links the post to that release's notes)
//   image: og-v1.3.0.png   (optional: a file in site/, shown under the title and used as the link preview)
//   draft: true            (optional: built only with SITE_DRAFTS=1)
//   ---
//
// The file name, minus .md, is the post's URL: /news/<name>/.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { render } from "./releases.ts"

export type Post = { slug: string; title: string; date: string; summary: string; release: string | null; image: string | null; draft: boolean; html: string }

const DIR = join(import.meta.dir, "posts")

export function parsePost(slug: string, text: string): Post {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"))
  if (!m) throw new Error(`site/posts/${slug}.md: no front matter`)
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line)
    if (kv) meta[kv[1]!] = kv[2]!.trim()
  }
  for (const k of ["title", "date", "summary"]) if (!meta[k]) throw new Error(`site/posts/${slug}.md: missing ${k}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.date!)) throw new Error(`site/posts/${slug}.md: date must be YYYY-MM-DD`)
  const image = meta.image || null
  if (image && (!/^[\w.-]+\.(png|jpe?g|webp)$/.test(image) || !existsSync(join(import.meta.dir, image)))) throw new Error(`site/posts/${slug}.md: image ${image} isn't a file in site/`)
  return { slug, title: meta.title!, date: meta.date!, summary: meta.summary!, release: meta.release || null, image, draft: meta.draft === "true", html: render(m[2]!) }
}

export function loadPosts(drafts = process.env.SITE_DRAFTS === "1"): Post[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parsePost(f.slice(0, -3), readFileSync(join(DIR, f), "utf8")))
    .filter((p) => drafts || !p.draft)
    .sort((a, b) => b.date.localeCompare(a.date))
}

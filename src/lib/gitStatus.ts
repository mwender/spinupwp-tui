// Local git drift for a linked working copy — Phase 4b.
//
// Network-free on purpose (no `git fetch`): we only report what's knowable
// instantly from the local repo — uncommitted changes (dirty) and commits not
// yet pushed to the upstream (ahead). Together these answer "do I have local
// work that isn't deployed yet?". "Behind remote" is intentionally omitted (it
// needs a network fetch + possibly SSH auth, against the app's no-slow-ops rule).

import { expandPath, findProjectRoot } from "./local.ts"

export interface Drift {
  dirty: boolean // uncommitted working-tree changes
  ahead: number // commits ahead of the upstream (0 if none / no upstream)
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    return { ok: code === 0, out: out.trim() }
  } catch {
    return { ok: false, out: "" }
  }
}

// Compute drift for a link's stored path. Resolves the actual repo root (which
// may be nested, e.g. app/). Returns null when the path isn't a git repo.
export async function gitDrift(linkPath: string): Promise<Drift | null> {
  const dir = findProjectRoot(expandPath(linkPath))
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"])
  if (!inside.ok || inside.out !== "true") return null
  const status = await git(dir, ["status", "--porcelain"])
  const dirty = status.out.length > 0
  const ahead = await git(dir, ["rev-list", "--count", "@{u}..HEAD"])
  return { dirty, ahead: ahead.ok ? parseInt(ahead.out, 10) || 0 : 0 }
}

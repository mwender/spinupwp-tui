// Git plumbing for Scheduler's git sources: pull before a tick, commit and push
// runs/ after, and the station claim (docs/2026-10-20_scheduler-spec.md, "One
// station per source").
//
// Commits name their paths (`commit -- <paths>`), never the whole index: once
// ~/SpinupTUI/ is the user's own repository, something they staged by hand must
// not ride along in a "runs:" commit.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, relative } from "node:path"
import { spawn } from "./spawn.ts"
import { jobEnv } from "./schedulerRun.ts"
import { claimPath, type Source } from "./schedulerJobs.ts"

export async function git(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const p = spawn(["git", "-C", dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: jobEnv() })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code: await p.exited, out: (out + err).trim() }
}

export async function gitPull(dir: string): Promise<string | null> {
  const r = await git(dir, "pull", "--rebase", "--autostash", "--quiet")
  return r.code === 0 ? null : `git pull failed: ${r.out}`
}

// Commits `paths` (relative to dir) when they changed, then pushes whenever the
// branch is ahead, so a push that failed on an earlier tick is retried.
export async function commitAndPush(dir: string, paths: string[], message: string): Promise<string | null> {
  await git(dir, "add", "-A", "--", ...paths)
  if ((await git(dir, "diff", "--cached", "--quiet", "--", ...paths)).code !== 0) {
    await git(dir, "commit", "--quiet", "-m", message, "--", ...paths)
  }
  const ahead = await git(dir, "rev-list", "--count", "@{u}..HEAD")
  if (ahead.code === 0 && ahead.out !== "" && ahead.out !== "0") {
    await gitPull(dir)
    const r = await git(dir, "push", "--quiet")
    if (r.code !== 0) return `git push failed (retried next tick): ${r.out}`
  }
  return null
}

// ---- the station claim ---------------------------------------------------------------

export function stationName(): string {
  return hostname().split(".")[0]!.toLowerCase()
}

export function readClaim(source: Source): string | null {
  try {
    return readFileSync(claimPath(source), "utf8").trim() || null
  } catch {
    return null
  }
}

const claimRel = (s: Source) => relative(s.path, claimPath(s))

export type ClaimDecision =
  | { run: true; claimed?: boolean } // ours, or just claimed
  | { run: false; holder: string | null; why: string }

// Called by a dispatcher tick on a git source, after its pull: decides whether
// this station runs the source, claiming it when nobody does. Two stations
// claiming at once are settled by git: the push that loses is undone, and the
// winner's claim arrives with the next pull.
export async function decideClaim(source: Source, host = stationName()): Promise<ClaimDecision> {
  const holder = readClaim(source)
  if (holder === host) return { run: true }
  if (holder) return { run: false, holder, why: `${source.name} is run by ${holder}; this machine only queues` }
  if (source.queueOnly) return { run: false, holder: null, why: `${source.name} was released here; this machine only queues` }

  const r = await writeClaim(source, host, `station: ${host} runs ${source.name}`)
  if (r === null) return { run: true, claimed: true }
  const now = readClaim(source)
  if (now && now !== host) return { run: false, holder: now, why: `${source.name} is run by ${now}; this machine only queues` }
  // Couldn't push and nobody else holds it (offline, say): don't run on an
  // unpublished claim. The next tick tries again.
  return { run: false, holder: null, why: `couldn't publish this station's claim on ${source.name} (${r}); will retry` }
}

// Writes, commits and pushes the claim. On a rejected push, undoes the local
// commit and pulls, so the caller can read whoever won. null = published.
export async function writeClaim(source: Source, host: string, message: string): Promise<string | null> {
  const path = claimPath(source)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, host + "\n")
  await git(source.path, "add", "--", claimRel(source))
  const c = await git(source.path, "commit", "--quiet", "-m", message, "--", claimRel(source))
  if (c.code !== 0 && !/nothing to commit|no changes added/.test(c.out)) return `git commit failed: ${c.out}`
  const p = await git(source.path, "push", "--quiet")
  if (p.code === 0) return null
  // Undo only what we did: the claim commit, and the claim file back to what
  // HEAD has (or gone, if HEAD has none). Never `reset --hard`, which would also
  // discard the user's own uncommitted work in their repository.
  if (c.code === 0) await git(source.path, "reset", "--quiet", "--soft", "HEAD~1")
  const restored = await git(source.path, "restore", "--source=HEAD", "--staged", "--worktree", "--", claimRel(source))
  if (restored.code !== 0) {
    await git(source.path, "restore", "--staged", "--", claimRel(source))
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
  }
  await gitPull(source.path)
  return `git push rejected: ${p.out.split("\n")[0]}`
}

// Removes this station's claim and publishes the removal. null = done.
export async function removeClaim(source: Source, message: string): Promise<string | null> {
  if (!existsSync(claimPath(source))) return null
  const rm = await git(source.path, "rm", "--quiet", "--", claimRel(source))
  if (rm.code !== 0) return `git rm failed: ${rm.out}`
  const c = await git(source.path, "commit", "--quiet", "-m", message, "--", claimRel(source))
  if (c.code !== 0) return `git commit failed: ${c.out}`
  const p = await git(source.path, "push", "--quiet")
  return p.code === 0 ? null : `committed, but the push failed (push it by hand): ${p.out.split("\n")[0]}`
}

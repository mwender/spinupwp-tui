// The one way this app starts a child process.
//
// Bun.spawn with no `env` option hands the child Bun's *startup* environment,
// ignoring anything deleted from process.env since — and so do Bun.spawnSync and
// node:child_process (all confirmed on Bun 1.3.14). That defeats the startup scrub
// of the launch directory's .env (see cwdDotenv.ts): a site checkout's DB_* values
// would still reach `wp`. Passing `env: process.env` does honor the deletions, so
// this wrapper defaults it. A caller's explicit `env` still wins.
//
// `bun run typecheck` fails on any direct Bun.spawn/spawnSync or child_process use
// outside this file, so new call sites can't quietly bypass it.

export const spawn = ((cmd: unknown, opts?: { env?: unknown }) => {
  if (Array.isArray(cmd)) return Bun.spawn(cmd, { ...opts, env: opts?.env ?? process.env } as never)
  const o = cmd as { env?: unknown }
  return Bun.spawn({ ...o, env: o.env ?? process.env } as never)
}) as typeof Bun.spawn

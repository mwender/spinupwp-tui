// Persistent clone-job logging (born from the 2026-07-02 web2→mercury failure,
// where all six errors were truncated to 24 chars in the roster and lost when the
// app closed). One JSONL file per clone job under <configDir>/logs/; every sudo
// script the pull chains run is recorded with its full stdout/stderr so a failed
// site can be diagnosed after the fact. Secrets (sudo + generated DB passwords)
// are redacted before anything touches disk.

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { configDir } from "../config.ts"

// Big outputs (composer, tar) are capped; keep the TAIL — errors come last.
const FIELD_CAP = 16_000

// Retention: swept every time a new job's logger is created (the only moment the
// app touches this dir), so nothing accumulates without a natural purge point. A
// log survives only while it's BOTH younger than MAX_AGE and among the newest
// MAX_LOGS. Copy a log elsewhere to keep it past retention.
const MAX_AGE_DAYS = 30
const MAX_LOGS = 20

function pruneOldLogs(dir: string): void {
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    const logs = readdirSync(dir)
      .filter((f) => f.startsWith("clone-") && f.endsWith(".jsonl"))
      .map((f) => {
        const path = join(dir, f)
        return { path, mtime: statSync(path).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const [i, l] of logs.entries()) {
      // The new job's log is about to join — keep MAX_LOGS-1 existing at most.
      if (l.mtime < cutoff || i >= MAX_LOGS - 1) {
        try {
          unlinkSync(l.path)
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* pruning must never break a clone */
  }
}

export class CloneLogger {
  readonly path: string
  private secrets: string[] = []

  constructor(label: string) {
    const dir = join(configDir(), "logs")
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* logging is best-effort */
    }
    pruneOldLogs(dir)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const slug = label.replace(/[^a-zA-Z0-9.-]+/g, "_").slice(0, 60)
    this.path = join(dir, `clone-${stamp}-${slug}.jsonl`)
  }

  // Register strings that must never reach disk (passwords). Call before log().
  redact(...secrets: (string | undefined)[]): void {
    for (const s of secrets) if (s && s.length >= 4 && !this.secrets.includes(s)) this.secrets.push(s)
  }

  private clean(v: unknown): unknown {
    if (typeof v !== "string") return v
    let s = v
    for (const secret of this.secrets) s = s.split(secret).join("[redacted]")
    return s.length > FIELD_CAP ? `…[${s.length - FIELD_CAP} chars trimmed]…${s.slice(-FIELD_CAP)}` : s
  }

  log(entry: Record<string, unknown>): void {
    try {
      const out: Record<string, unknown> = { ts: new Date().toISOString() }
      for (const [k, v] of Object.entries(entry)) out[k] = this.clean(v)
      appendFileSync(this.path, JSON.stringify(out) + "\n")
    } catch {
      /* never let logging break a clone */
    }
  }
}

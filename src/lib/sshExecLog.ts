// Audit trail for `spinuptui ssh-exec` — one JSONL line per attempt (allowed,
// denied, or a resolution failure), so "did this ever write to a server" has a
// durable answer independent of whatever the calling agent reports. Modeled on
// src/lib/cloneLog.ts's JSONL-under-configDir/logs pattern.

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { configDir } from "../config.ts"

const FIELD_CAP = 2_000

function auditLogPath(): string {
  return join(configDir(), "logs", "ssh-exec-audit.jsonl")
}

function cap(v: unknown): unknown {
  if (typeof v !== "string" || v.length <= FIELD_CAP) return v
  return `${v.slice(0, FIELD_CAP)}…[${v.length - FIELD_CAP} chars trimmed]`
}

export function logSshExecAttempt(entry: Record<string, unknown>): void {
  try {
    const dir = join(configDir(), "logs")
    mkdirSync(dir, { recursive: true })
    const out: Record<string, unknown> = { ts: new Date().toISOString() }
    for (const [k, v] of Object.entries(entry)) out[k] = cap(v)
    appendFileSync(auditLogPath(), JSON.stringify(out) + "\n")
  } catch {
    /* audit logging is best-effort — must never break a diagnostic command */
  }
}

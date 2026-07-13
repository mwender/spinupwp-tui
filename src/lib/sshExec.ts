// `spinuptui ssh-exec <domain> -- <command>` — gated, read-only SSH command
// execution for external tooling (e.g. a diagnostics agent). Resolves domain ->
// SSH target the same way `spinuptui ssh` does, checks the command against the
// read-only allowlist (sshExecPolicy.ts), and only then runs it. Every attempt —
// allowed, denied, or a resolution failure — is written to the audit log
// (sshExecLog.ts) so the answer to "did this ever touch a server" doesn't depend
// on the calling agent's own report.

import type { AppConfig } from "../config.ts"
import type { SpinupWPClientLike } from "../api/client.ts"
import { resolveSshTargetInfo, type SshAccessReason, type SshAccessCandidate } from "./cliSsh.ts"
import { SSH_OPTS } from "./probe.ts"
import { classifySshCommand } from "./sshExecPolicy.ts"
import { logSshExecAttempt } from "./sshExecLog.ts"

export type SshExecReason = SshAccessReason | "command_denied"

export type SshExecResult =
  | {
      ok: true
      domain: string
      primaryDomain: string
      sshTarget: string
      command: string
      exitCode: number
      stdout: string
      stderr: string
      durationMs: number
    }
  | {
      ok: false
      domain: string
      reason: SshExecReason
      message: string
      command?: string
      remedy?: string
      candidates?: SshAccessCandidate[]
    }

const EXEC_TIMEOUT_MS = 30_000

export async function execSshCommand(
  domain: string,
  command: string,
  client: SpinupWPClientLike,
  cfg: AppConfig,
): Promise<SshExecResult> {
  const resolution = await resolveSshTargetInfo(domain, client, cfg)
  if (!resolution.ok) {
    logSshExecAttempt({ domain, command, decision: "error", reason: resolution.result.reason, message: resolution.result.message })
    return { ...resolution.result, command }
  }
  const { primaryDomain, sshTarget, port } = resolution.info

  const verdict = classifySshCommand(command)
  if (verdict.decision === "deny") {
    logSshExecAttempt({ domain: primaryDomain, command, decision: "denied", reason: verdict.reason })
    return { ok: false, domain, reason: "command_denied", message: verdict.reason, command }
  }

  const portOpt = port ? ["-p", String(port)] : []
  const start = Date.now()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, ...portOpt, sshTarget, command], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
  } catch (err) {
    const message = `Failed to launch ssh: ${(err as Error).message}`
    logSshExecAttempt({ domain: primaryDomain, command, decision: "error", reason: "ssh_error", message })
    return { ok: false, domain, reason: "ssh_error", message, command }
  }

  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, EXEC_TIMEOUT_MS)

  const exitCode = await proc.exited
  clearTimeout(timeout)
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
  const durationMs = Date.now() - start

  logSshExecAttempt({ domain: primaryDomain, command, decision: "allowed", exitCode, stdout, stderr, durationMs })

  return { ok: true, domain, primaryDomain, sshTarget, command, exitCode, stdout, stderr, durationMs }
}

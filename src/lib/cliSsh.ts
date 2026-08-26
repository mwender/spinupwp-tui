// `spinuptui ssh <domain>` — non-interactive SSH access lookup for external
// tooling (e.g. an incident-diagnostics agent that's handed only a domain).
// Resolves domain -> site -> server -> SSH target, then runs a live
// connectivity probe (BatchMode, same as probeSite) so the result is a
// trustworthy go/no-go rather than a guess.

import type { AppConfig } from "../config.ts"
import type { Server, Site } from "../api/types.ts"
import type { SpinupWPClientLike } from "../api/client.ts"
import { ApiError } from "../api/client.ts"
import { resolveSiteSshTarget, SSH_OPTS } from "./probe.ts"

export type SshAccessReason =
  | "no_token"
  | "token_rejected"
  | "site_not_found"
  | "multiple_matches"
  | "server_has_no_ip"
  | "permission_denied"
  | "connection_failed"
  | "ssh_error"
  | "api_error"

export interface SshAccessCandidate {
  siteId: number
  serverId: number
  server: string
}

export type SshAccessResult =
  | { ok: true; domain: string; primaryDomain: string; sshTarget: string; port: number | null; server: string }
  | {
      ok: false
      domain: string
      reason: SshAccessReason
      message: string
      remedy?: string
      candidates?: SshAccessCandidate[]
    }

const GRANT_KEY_REMEDY =
  "Run `spinuptui`, select this site in the Browser view, and press K to grant this device's key (sudo must be connected on the server first — press S)."

// Resolved SSH connection details for a domain, without having tested them.
export interface SshTargetInfo {
  domain: string
  primaryDomain: string
  sshTarget: string
  port: number | null
  server: string
}

export type SshTargetResolution =
  | { ok: true; info: SshTargetInfo }
  | { ok: false; result: SshAccessResult & { ok: false } }

// A resolved domain, before anything is done with it. Shared by every
// domain-addressed CLI command (`ssh`, `ssh-exec`, `pull`) so they all fail the
// same way — same reason codes, same messages — on an unknown or ambiguous
// domain, a rejected token, or a server with no IP.
export type SiteResolution =
  | { ok: true; site: Site; server: Server }
  | { ok: false; result: SshAccessResult & { ok: false } }

export async function resolveSiteByDomain(
  domain: string,
  client: SpinupWPClientLike,
  cfg: AppConfig,
): Promise<SiteResolution> {
  const fail = (
    partial: Omit<SshAccessResult & { ok: false }, "ok" | "domain">,
  ): SiteResolution => ({ ok: false, result: { ok: false, domain, ...partial } })

  if (!cfg.token) {
    return fail({ reason: "no_token", message: "No API token configured. Run `spinuptui login`." })
  }

  let site: Site
  let server: Server
  try {
    const sites = await client.listSites()
    const matches = sites.filter(
      (s) => s.domain === domain || s.additional_domains?.some((a) => a.domain === domain),
    )
    if (matches.length === 0) {
      return fail({
        reason: "site_not_found",
        message: `No site matching "${domain}" found in this SpinupWP account.`,
      })
    }
    if (matches.length > 1) {
      const candidates: SshAccessCandidate[] = await Promise.all(
        matches.map(async (s) => {
          const srv = await client.getServer(s.server_id)
          return { siteId: s.id, serverId: s.server_id, server: srv.name }
        }),
      )
      return fail({
        reason: "multiple_matches",
        message: `"${domain}" matches ${matches.length} sites in this account — cannot pick one automatically.`,
        candidates,
      })
    }
    site = matches[0]!
    server = await client.getServer(site.server_id)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return fail({
        reason: "token_rejected",
        message: "Saved API token was rejected (401) — it may be expired or revoked.",
        remedy: "Run `spinuptui login` to save a fresh token.",
      })
    }
    const message = err instanceof ApiError ? err.message : `Unexpected error: ${(err as Error).message}`
    return fail({ reason: "api_error", message })
  }

  if (!server.ip_address) {
    return fail({ reason: "server_has_no_ip", message: `Server "${server.name}" has no IP address on file.` })
  }

  return { ok: true, site, server }
}

// Domain -> site -> server -> SSH target/port, with no live connectivity check.
// Split out of resolveSshAccess so callers that are about to run a real command
// (which is itself a connectivity test) don't pay for a redundant probe first.
export async function resolveSshTargetInfo(
  domain: string,
  client: SpinupWPClientLike,
  cfg: AppConfig,
): Promise<SshTargetResolution> {
  const resolved = await resolveSiteByDomain(domain, client, cfg)
  if (!resolved.ok) return resolved

  const { site, server } = resolved
  const target = resolveSiteSshTarget(site, server, cfg.sshUser)
  const port = server.ssh_port && server.ssh_port !== 22 ? server.ssh_port : null

  return {
    ok: true,
    info: { domain, primaryDomain: site.domain, sshTarget: target, port, server: server.name },
  }
}

export async function resolveSshAccess(
  domain: string,
  client: SpinupWPClientLike,
  cfg: AppConfig,
): Promise<SshAccessResult> {
  const resolution = await resolveSshTargetInfo(domain, client, cfg)
  if (!resolution.ok) return resolution.result
  const { primaryDomain, sshTarget: target, port, server: serverName } = resolution.info
  const portOpt = port ? ["-p", String(port)] : []

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, ...portOpt, target, "true"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
  } catch (err) {
    return { ok: false, domain, reason: "ssh_error", message: `Failed to launch ssh: ${(err as Error).message}` }
  }

  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, 15000)

  const exitCode = await proc.exited
  clearTimeout(timeout)
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()

  if (exitCode === 0) {
    return { ok: true, domain, primaryDomain, sshTarget: target, port, server: serverName }
  }

  if (/permission denied/i.test(stderr)) {
    return {
      ok: false,
      domain,
      reason: "permission_denied",
      message: stderr.trim().split("\n").slice(-2).join(" ") || "Permission denied.",
      remedy: GRANT_KEY_REMEDY,
    }
  }
  if (/(connection timed out|operation timed out|connection refused|could not resolve)/i.test(stderr)) {
    return {
      ok: false,
      domain,
      reason: "connection_failed",
      message: stderr.trim().split("\n").slice(-2).join(" ") || `ssh exited with code ${exitCode}`,
    }
  }
  return {
    ok: false,
    domain,
    reason: "ssh_error",
    message: stderr.trim().split("\n").slice(-2).join(" ") || `ssh exited with code ${exitCode}`,
  }
}

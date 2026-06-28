// Orchestrator for "clone a server to a new server" (backlog item 5). Built on the
// sudo-over-SSH transport (mirrors ssh.ts runSudoSiteOp): SSH to the server's sudo
// user with your key, then `sudo -S` reads the password from stdin so nothing is
// injected or persisted. The privileged password is passed in by the caller (the
// store holds it in memory; a headless harness reads a dev one) — never stored here.
//
// SLICE 4a (this file): the transport + source-read sizing for the Plan step. The
// per-site pull chain (create → pull → config → deploy → verify) lands next; it
// extends this same transport. See docs/2026-06-24_clone-to-server-spec.md and
// docs/2026-06-27_site-creation-api-findings.md (the create-only/git-deploy findings
// that shape the Bedrock branch).

import type { Server } from "../api/types.ts"

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"]

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface SudoResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

// Run a bash script as root on `server` via its sudo user. `script` is fed on stdin
// after the password line, so `sudo -S -p ''` consumes the password and bash reads
// the rest. Key-based SSH to the sudo user is assumed (same as SudoConnect).
export async function sudoExec(
  server: Server,
  sudoUser: string,
  sudoPassword: string,
  script: string,
  timeoutMs = 120_000,
): Promise<SudoResult> {
  const ip = server.ip_address ?? ""
  const target = `${sudoUser}@${ip}`
  const portOpt = server.ssh_port ? ["-p", String(server.ssh_port)] : []
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const proc = Bun.spawn(["ssh", ...SSH_OPTS, ...portOpt, target, "sudo -S -p '' bash -s"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      signal: ctrl.signal,
    })
    proc.stdin.write(`${sudoPassword}\n${script}`)
    await proc.stdin.end()
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, stdout, stderr, code }
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message, code: -1 }
  } finally {
    clearTimeout(timer)
  }
}

export interface SiteSizeInput {
  siteId: number
  domain: string
  siteUser: string
}

// Estimate each source site's payload (webroot bytes + DB bytes) in ONE round trip.
// Webroot via `du -sb /sites/<domain>/files`; DB via `wp db size --size_format=b`
// run as the site user from that dir (wp-cli.yml resolves Bedrock's web/wp path and
// reads .env). Sites whose probe fails are simply omitted from the map.
export async function estimateSourceSiteSizes(
  server: Server,
  sudoUser: string,
  sudoPassword: string,
  sites: SiteSizeInput[],
): Promise<Map<number, number>> {
  if (sites.length === 0) return new Map()
  const lines = sites.map((s) => {
    const root = `/sites/${s.domain}/files`
    return [
      `D=${shq(root)}`,
      `wb=$(du -sb "$D" 2>/dev/null | cut -f1)`,
      `db=$(cd "$D" 2>/dev/null && sudo -u ${shq(s.siteUser)} -H wp db size --size_format=b 2>/dev/null | tr -dc 0-9)`,
      `echo "${s.siteId} \${wb:-0} \${db:-0}"`,
    ].join("; ")
  })
  const res = await sudoExec(server, sudoUser, sudoPassword, lines.join("\n"), 120_000)
  const out = new Map<number, number>()
  if (!res.ok) return out
  for (const line of res.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (!m) continue
    const id = Number(m[1])
    const total = Number(m[2]) + Number(m[3])
    if (total > 0) out.set(id, total)
  }
  return out
}

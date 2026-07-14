// macOS Keychain storage for sudo passwords (opt-in), via the built-in `security`
// CLI — zero dependencies, service-scoped to one item per server. The password lives
// ONLY in the Keychain + the in-memory session ref; it never touches config.json.
//
// Off macOS this no-ops (keychainAvailable() === false) and sudo stays in-memory per
// session, exactly as before. NOTE: `security add-generic-password` takes the password
// as an argv value (-w), so it's briefly visible to `ps` on the local machine during
// the write — acceptable for an opt-in convenience on a personal box; documented here.

const SERVICE = "spinup-sudo"

export function keychainAvailable(): boolean {
  return process.platform === "darwin"
}

function account(serverId: number): string {
  return `server-${serverId}`
}

async function security(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["security", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { ok: code === 0, stdout, stderr }
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message }
  }
}

export interface KeychainWriteResult {
  ok: boolean
  // `security`'s own error line (e.g. "User interaction is not allowed." when the
  // login keychain is locked) — set whenever ok is false and on macOS, so the
  // caller can show the real reason instead of a silent no-op.
  error?: string
}

// Store (or update) a server's sudo password. ok:false off macOS / on failure.
export async function setSudoPassword(serverId: number, password: string): Promise<KeychainWriteResult> {
  if (!keychainAvailable()) return { ok: false }
  const r = await security(["add-generic-password", "-U", "-s", SERVICE, "-a", account(serverId), "-w", password])
  if (r.ok) return { ok: true }
  return { ok: false, error: r.stderr.trim().replace(/^security:\s*/, "") || "the Keychain write failed" }
}

// Retrieve a server's sudo password, or null if absent / denied / off macOS. The first
// read of an item may surface macOS's own "allow access" prompt (then Always Allow).
export async function getSudoPassword(serverId: number): Promise<string | null> {
  if (!keychainAvailable()) return null
  const r = await security(["find-generic-password", "-s", SERVICE, "-a", account(serverId), "-w"])
  return r.ok ? r.stdout.replace(/\n+$/, "") : null
}

// Remove a server's stored sudo password (best-effort).
export async function deleteSudoPassword(serverId: number): Promise<void> {
  if (!keychainAvailable()) return
  await security(["delete-generic-password", "-s", SERVICE, "-a", account(serverId)])
}

// Live server health over SSH.
//
// SpinupWP exposes no live metrics API, so the health view shells out to the
// local `ssh` client (using the user's existing keys/agent) and reads /proc,
// df, and ps on the server — exactly the data `htop` shows. All remote commands
// are strictly read-only.
//
// Auth is non-interactive (BatchMode): if `ssh user@ip` doesn't already work
// from the user's terminal, we fail fast with a clear hint instead of hanging.
// A persistent ControlMaster connection makes repeated polls fast.

import { hostname, homedir } from "node:os"
import { join } from "node:path"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, chmod } from "node:fs/promises"
import { keysDir } from "../config.ts"
import type { Server, Site } from "../api/types.ts"

export interface CpuCore {
  idx: number
  pct: number
}

export interface DiskMount {
  mount: string
  total: number
  used: number
  pct: number
}

export interface ProcInfo {
  pid: string
  comm: string
  cpu: number
  mem: number
}

export interface HealthSnapshot {
  host: string
  uptimeSecs: number
  load: [number, number, number]
  cores: number
  cpuPct: number
  perCore: CpuCore[]
  memTotal: number
  memUsed: number
  memAvailable: number
  swapTotal: number
  swapUsed: number
  disks: DiskMount[]
  processes: ProcInfo[]
  takenAt: number
}

export type HealthResult =
  | { ok: true; target: string; snapshot: HealthSnapshot }
  | { ok: false; target: string; error: string }

// Resolve `user@host` for a server. Prefers an explicit config override, then a
// site's `site_user` on that server, then falls back to root.
export function resolveSshTarget(server: Server, sites: Site[], sshUser: string | null): string {
  if (!server.ip_address) return ""
  if (sshUser) return `${sshUser}@${server.ip_address}`
  const site = sites.find((s) => s.server_id === server.id && s.site_user)
  const user = site?.site_user || "root"
  return `${user}@${server.ip_address}`
}

// One batched command that captures everything we render in a single round-trip.
// Two /proc/stat reads bracket a short sleep so we can compute live CPU%.
const REMOTE_SCRIPT = [
  "echo ===HOST; hostname 2>/dev/null",
  "echo ===UPTIME; cat /proc/uptime",
  "echo ===LOAD; cat /proc/loadavg",
  "echo ===NPROC; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo",
  "echo ===STAT1; grep '^cpu' /proc/stat",
  "sleep 0.75",
  "echo ===STAT2; grep '^cpu' /proc/stat",
  "echo ===MEM; cat /proc/meminfo",
  "echo ===DF; df -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null",
  "echo ===PS; ps -eo pid,comm,pcpu,pmem --sort=-pcpu 2>/dev/null | head -n 9",
  "echo ===END",
].join("; ")

const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=7",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ControlMaster=auto",
  "-o", "ControlPath=/tmp/spinup-cm-%r@%h:%p",
  "-o", "ControlPersist=30s",
]

// Why a server needs a reboot. SpinupWP's `reboot_required` boolean tracks
// Ubuntu's /var/run/reboot-required (written by unattended-upgrades), which a
// fleet-wide check confirmed 1:1; the companion .pkgs file lists the packages
// awaiting a restart. We surface that as accurate OS-level context — labeled as
// what it is, not as SpinupWP's internal logic. Read-only, like the health view.
export interface RebootInfo {
  present: boolean // /var/run/reboot-required exists
  packages: string[] // de-duplicated package names from .pkgs
  kernel: boolean // any linux-image* package present (the security-relevant case)
}

export type RebootInfoResult =
  | { ok: true; target: string; info: RebootInfo }
  | { ok: false; target: string; error: string }

const REBOOT_SCRIPT = [
  "echo ===PRESENT; test -e /var/run/reboot-required && echo yes || echo no",
  "echo ===PKGS; cat /var/run/reboot-required.pkgs 2>/dev/null",
  "echo ===END",
].join("; ")

export async function fetchRebootInfo(
  server: Server,
  sites: Site[],
  sshUser: string | null,
): Promise<RebootInfoResult> {
  const target = resolveSshTarget(server, sites, sshUser)
  if (!target) return { ok: false, target: "(no IP)", error: "Server has no IP address." }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, target, REBOOT_SCRIPT], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  } catch (err) {
    return { ok: false, target, error: `Failed to launch ssh: ${(err as Error).message}` }
  }
  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, 12000)
  const exitCode = await proc.exited
  clearTimeout(timeout)
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()

  if (exitCode !== 0 || !stdout.includes("===END")) {
    const reason = stderr.trim().split("\n").slice(-2).join(" ") || `ssh exited with code ${exitCode}`
    return { ok: false, target, error: reason }
  }

  const s = splitSections(stdout)
  const present = (s.PRESENT?.[0] || "").trim() === "yes"
  // .pkgs has duplicate lines in practice; de-dupe while preserving order.
  const packages = [...new Set((s.PKGS || []).map((l) => l.trim()).filter(Boolean))]
  const kernel = packages.some((p) => p.startsWith("linux-image"))
  return { ok: true, target, info: { present, packages, kernel } }
}

export async function fetchServerHealth(
  server: Server,
  sites: Site[],
  sshUser: string | null,
): Promise<HealthResult> {
  const target = resolveSshTarget(server, sites, sshUser)
  if (!target) return { ok: false, target: "(no IP)", error: "Server has no IP address." }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, target, REMOTE_SCRIPT], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
  } catch (err) {
    return { ok: false, target, error: `Failed to launch ssh: ${(err as Error).message}` }
  }

  // Guard against a hung connection beyond ssh's own ConnectTimeout.
  const timeout = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, 12000)

  const exitCode = await proc.exited
  clearTimeout(timeout)
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()

  if (exitCode !== 0 || !stdout.includes("===END")) {
    const reason = stderr.trim().split("\n").slice(-2).join(" ") || `ssh exited with code ${exitCode}`
    return { ok: false, target, error: reason }
  }

  try {
    return { ok: true, target, snapshot: parseHealth(stdout) }
  } catch (err) {
    return { ok: false, target, error: `Could not parse server output: ${(err as Error).message}` }
  }
}

// Split the batched output into its labelled sections.
function splitSections(out: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {}
  let current = ""
  for (const rawLine of out.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    const m = line.match(/^===([A-Z0-9]+)$/)
    if (m) {
      current = m[1]
      sections[current] = []
    } else if (current) {
      sections[current].push(line)
    }
  }
  return sections
}

// Parse one /proc/stat cpu line into [total, idle].
function parseCpuLine(line: string): { total: number; idle: number } | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 5) return null
  const nums = parts.slice(1).map((n) => parseInt(n, 10) || 0)
  const idle = (nums[3] || 0) + (nums[4] || 0) // idle + iowait
  const total = nums.reduce((a, b) => a + b, 0)
  return { total, idle }
}

function busyPct(a: { total: number; idle: number }, b: { total: number; idle: number }): number {
  const dTotal = b.total - a.total
  const dIdle = b.idle - a.idle
  if (dTotal <= 0) return 0
  return Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100))
}

// ---- Privileged write-over-SSH (sudo) -------------------------------------
//
// The app's first WRITE over SSH: drop Spinup's dedicated machine key into a
// site user's authorized_keys, via a per-server SUDO user. Everything above this
// line is strictly read-only; this section is the one place we mutate a server.
//
// See docs/2026-06-26_sudo-ssh-key-provisioning-spec.md for the why (the SpinupWP
// API has no SSH-key/sudo-user surface) and the clobber-safety analysis (an
// appended key survives SpinupWP's authorized_keys reconciliation as long as it
// isn't also a saved account key — hence a dedicated key NOT in the account).

// Path to Spinup's dedicated machine keypair (private + .pub).
function spinupKeyPaths(): { path: string; pub: string } {
  const path = join(keysDir(), "spinup-tui")
  return { path, pub: `${path}.pub` }
}

// Lazily generate (once) and return Spinup's dedicated ed25519 machine key. It is
// NEVER added to the SpinupWP account, so SpinupWP never manages/removes it; the
// public-key comment (`spinup-tui@<hostname>`) makes its origin obvious wherever
// the authorized_keys line is seen. No passphrase — it's an unattended identity.
export async function ensureSpinupKey(): Promise<{ path: string; pub: string; comment: string }> {
  const { path, pub } = spinupKeyPaths()
  const comment = `spinup-tui@${hostname()}`
  if (existsSync(pub) && existsSync(path)) {
    return { path, pub: readFileSync(pub, "utf8").trim(), comment }
  }
  await mkdir(keysDir(), { recursive: true })
  const proc = Bun.spawn(
    ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", comment, "-f", path],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  )
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
    throw new Error(`ssh-keygen failed (${code}): ${err.trim() || "could not generate the machine key"}`)
  }
  // The private key is a machine identity — restrict it to the owner.
  try {
    await chmod(path, 0o600)
  } catch {
    /* best-effort (e.g. filesystems without POSIX perms) */
  }
  return { path, pub: readFileSync(pub, "utf8").trim(), comment }
}

// SpinupWP serves each site from /sites/<domain>; the site user's home (and thus
// its .ssh/authorized_keys) lives there.
function siteHome(domain: string): string {
  return `/sites/${domain}`
}

// Single-quote a value for safe embedding in a POSIX shell script.
function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

// The idempotent remote script that ensures EACH given key line is present in the
// site user's authorized_keys (mode 600, owned siteuser:siteuser). `grep -qxF` makes
// re-running a no-op; it verifies every key landed before echoing ===GRANTED, so a
// partial write reports failure. Exported so the confirm overlay can show the exact
// remote command before firing.
export function buildGrantScript(siteUser: string, domain: string, pubkeys: string[]): string {
  const U = shQuote(siteUser)
  const H = shQuote(siteHome(domain))
  const lines = [
    `set -e`,
    `U=${U}; H=${H}`,
    `install -d -m 700 -o "$U" -g "$U" "$H/.ssh"`,
    `touch "$H/.ssh/authorized_keys"`,
  ]
  // Append each key only if absent (idempotent), keyed off the exact line.
  for (const k of pubkeys) {
    const K = shQuote(k)
    lines.push(`grep -qxF ${K} "$H/.ssh/authorized_keys" || printf '%s\\n' ${K} >> "$H/.ssh/authorized_keys"`)
  }
  lines.push(`chown "$U:$U" "$H/.ssh/authorized_keys"`)
  lines.push(`chmod 600 "$H/.ssh/authorized_keys"`)
  // Verify every key is present; bail (no ===GRANTED) if any is missing.
  for (const k of pubkeys) {
    lines.push(`grep -qxF ${shQuote(k)} "$H/.ssh/authorized_keys" || exit 7`)
  }
  lines.push(`echo ===GRANTED`)
  return lines.join("\n")
}

// A non-interactive ssh command, optionally feeding a sudo password (then a
// script body) on stdin. We do NOT drive an interactive `sudo -i` shell: we run
// one shot `sudo -S -p '' bash -s`, so the password is read from stdin (-S) and
// never appears in argv (so not in the remote `ps`/history). When `password` is
// null the remote command runs without sudo (used for the read-only probe).
async function runSshStdin(
  target: string,
  port: number | null,
  remoteCmd: string,
  stdinPayload: string | null,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const portOpt = port && port !== 22 ? ["-p", String(port)] : []
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, ...portOpt, target, remoteCmd], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdinPayload == null ? "ignore" : "pipe",
    })
  } catch (err) {
    return { code: -1, stdout: "", stderr: `Failed to launch ssh: ${(err as Error).message}` }
  }
  if (stdinPayload != null && proc.stdin) {
    const sink = proc.stdin as { write: (s: string) => void; end: () => void }
    sink.write(stdinPayload)
    sink.end()
  }
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, timeoutMs)
  const code = await proc.exited
  clearTimeout(timer)
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
  return { code, stdout, stderr }
}

// Pull a meaningful last line out of ssh/sudo stderr for surfacing to the user.
function lastErrorLine(stderr: string, fallback: string): string {
  const line = stderr.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop()
  return line || fallback
}

export type GrantKeyResult =
  | { ok: true; target: string }
  | { ok: false; target: string; error: string }

// Append the given public keys to a site user's authorized_keys, via the server's
// sudo user. Probes `sudo -n true` first to fail cleanly (can't-sudo / can't-connect)
// BEFORE sending the secret; if a password is required it's fed on stdin to `sudo -S`.
// Idempotent (re-running never duplicates a line). The caller resolves which keys to
// deploy (machine key via ensureSpinupKey, personal keys via listPersonalKeys).
export async function grantSiteSshKey(
  server: Server,
  site: Site,
  opts: { sudoUser: string; sudoPassword: string; pubkeys: string[] },
): Promise<GrantKeyResult> {
  const ip = server.ip_address
  if (!ip) return { ok: false, target: "(no IP)", error: "Server has no IP address." }
  const siteUser = site.site_user
  if (!siteUser) return { ok: false, target: ip, error: "Site has no site_user — can't locate its authorized_keys." }
  const keys = opts.pubkeys.map((k) => k.trim()).filter(Boolean)
  if (keys.length === 0) return { ok: false, target: `${siteUser}@${ip}`, error: "No keys selected to grant." }
  const target = `${opts.sudoUser}@${ip}`
  const port = server.ssh_port ?? null

  // 1) Probe: confirms we can log in AND can sudo, without sending the password.
  //    `sudo -n true` exits 0 for passwordless sudo, non-zero otherwise.
  const probe = await runSshStdin(target, port, "sudo -n true 2>&1", null, 15000)
  let needPassword = false
  if (probe.code === 0) {
    needPassword = false // passwordless sudo — don't prepend a password line
  } else if (probe.code === 255 || probe.code === -1) {
    // ssh-level failure (connection refused / Permission denied (publickey) / …).
    return { ok: false, target, error: lastErrorLine(probe.stdout + "\n" + probe.stderr, "Couldn't connect over SSH — is your key on the server for this user?") }
  } else {
    const out = (probe.stdout + " " + probe.stderr).toLowerCase()
    if (/not in the sudoers|not allowed to run|may not run|unknown user|is not allowed/.test(out)) {
      return { ok: false, target, error: `${opts.sudoUser} can't run sudo on this server.` }
    }
    // Otherwise sudo wants a password (the expected path).
    needPassword = true
    if (!opts.sudoPassword) return { ok: false, target, error: "A sudo password is required for this server." }
  }

  // 2) Act: one idempotent script under sudo, password (if needed) fed on stdin.
  const script = buildGrantScript(siteUser, site.domain, keys)
  const payload = needPassword ? `${opts.sudoPassword}\n${script}\n` : `${script}\n`
  const res = await runSshStdin(target, port, "sudo -S -p '' bash -s", payload, 30000)
  if (res.code !== 0 || !res.stdout.includes("===GRANTED")) {
    const out = (res.stderr + " " + res.stdout).toLowerCase()
    if (/incorrect password|sorry, try again|authentication failure/.test(out)) {
      return { ok: false, target, error: "Sudo password was rejected." }
    }
    return { ok: false, target, error: lastErrorLine(res.stderr || res.stdout, `The remote command failed (ssh exit ${res.code}).`) }
  }
  return { ok: true, target: `${siteUser}@${ip}` }
}

// A public key the user can choose to grant. The machine key (`spinup-tui`) plus any
// personal keys discovered on this machine. `line` is the full authorized_keys line.
export interface GrantableKey {
  id: string // stable id for selection (the key body, base64)
  kind: "machine" | "personal"
  label: string // human label (comment or filename)
  line: string // the full "ssh-… AAAA… comment" line
  source: string // "spinup" | "~/.ssh/id_ed25519.pub" | "ssh-agent"
}

// The base64 body of a public-key line — the stable identity used to dedupe keys
// across the agent and ~/.ssh, and to match what SpinupWP keys off.
function keyBody(line: string): string {
  const parts = line.trim().split(/\s+/)
  return parts[1] ?? ""
}

function parsePubLine(line: string): { type: string; body: string; comment: string } | null {
  const t = line.trim()
  if (!t || !/^(ssh|ecdsa|sk-)/.test(t)) return null
  const parts = t.split(/\s+/)
  if (parts.length < 2) return null
  return { type: parts[0], body: parts[1], comment: parts.slice(2).join(" ") }
}

// Discover the user's PERSONAL public keys to offer alongside the machine key:
// every ~/.ssh/*.pub plus whatever the ssh-agent currently holds (`ssh-add -L`),
// deduped by key body. These are the keys a human uses to log in as themselves.
export async function listPersonalKeys(): Promise<GrantableKey[]> {
  const byBody = new Map<string, GrantableKey>()
  const add = (line: string, label: string, source: string) => {
    const parsed = parsePubLine(line)
    if (!parsed) return
    if (byBody.has(parsed.body)) return // first source wins (files are listed first)
    byBody.set(parsed.body, {
      id: parsed.body,
      kind: "personal",
      label: parsed.comment || label,
      line: line.trim(),
      source,
    })
  }

  // ~/.ssh/*.pub
  try {
    const dir = join(homedir(), ".ssh")
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".pub")) continue
      try {
        add(readFileSync(join(dir, name), "utf8"), name, `~/.ssh/${name}`)
      } catch {
        /* unreadable — skip */
      }
    }
  } catch {
    /* no ~/.ssh — fine */
  }

  // ssh-agent (keys the user has loaded). Best-effort; ignore if no agent.
  try {
    const proc = Bun.spawn(["ssh-add", "-L"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const code = await proc.exited
    if (code === 0) {
      const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
      for (const line of out.split("\n")) add(line, "ssh-agent key", "ssh-agent")
    }
  } catch {
    /* no ssh-add / no agent — fine */
  }

  // ed25519 first (the modern default people actually use), then the rest in
  // discovery order — so the first entry is the most likely "my key".
  return [...byBody.values()].sort((a, b) => {
    const rank = (k: GrantableKey) => (k.line.startsWith("ssh-ed25519") ? 0 : 1)
    return rank(a) - rank(b)
  })
}

export { keyBody }

export type SudoVerifyResult = { ok: true } | { ok: false; error: string }

// Validate a server's sudo credentials live (login as the sudo user works AND the
// password is accepted by sudo), so "arming" a server gives immediate pass/fail
// before any real privileged action fires. `sudo -S -p '' true` reads the password
// from stdin; passwordless sudo ignores stdin and still exits 0.
export async function verifySudo(server: Server, opts: { sudoUser: string; sudoPassword: string }): Promise<SudoVerifyResult> {
  const ip = server.ip_address
  if (!ip) return { ok: false, error: "Server has no IP address." }
  const target = `${opts.sudoUser}@${ip}`
  const port = server.ssh_port ?? null
  const res = await runSshStdin(target, port, "sudo -S -p '' true", `${opts.sudoPassword}\n`, 15000)
  if (res.code === 0) return { ok: true }
  if (res.code === 255 || res.code === -1) {
    return { ok: false, error: lastErrorLine(res.stderr || res.stdout, "Couldn't connect over SSH — is your key on the sudo user?") }
  }
  const out = (res.stderr + " " + res.stdout).toLowerCase()
  if (/incorrect password|sorry, try again|authentication failure/.test(out)) return { ok: false, error: "Sudo password was rejected." }
  if (/not in the sudoers|not allowed to run|may not run|unknown user|is not allowed/.test(out)) {
    return { ok: false, error: `${opts.sudoUser} can't run sudo on this server.` }
  }
  return { ok: false, error: lastErrorLine(res.stderr || res.stdout, `Verification failed (ssh exit ${res.code}).`) }
}

function parseHealth(out: string): HealthSnapshot {
  const s = splitSections(out)

  const host = (s.HOST?.[0] || "").trim()
  const uptimeSecs = parseFloat(s.UPTIME?.[0]?.trim().split(/\s+/)[0] || "0")
  const loadParts = (s.LOAD?.[0] || "").trim().split(/\s+/)
  const load: [number, number, number] = [
    parseFloat(loadParts[0] || "0"),
    parseFloat(loadParts[1] || "0"),
    parseFloat(loadParts[2] || "0"),
  ]
  const cores = parseInt(s.NPROC?.[0]?.trim() || "1", 10) || 1

  // CPU% from the two /proc/stat snapshots, keyed by cpu label (cpu, cpu0, …).
  const stat1 = new Map<string, { total: number; idle: number }>()
  const stat2 = new Map<string, { total: number; idle: number }>()
  for (const line of s.STAT1 || []) {
    const label = line.trim().split(/\s+/)[0]
    const parsed = parseCpuLine(line)
    if (label && parsed) stat1.set(label, parsed)
  }
  for (const line of s.STAT2 || []) {
    const label = line.trim().split(/\s+/)[0]
    const parsed = parseCpuLine(line)
    if (label && parsed) stat2.set(label, parsed)
  }
  const agg1 = stat1.get("cpu")
  const agg2 = stat2.get("cpu")
  const cpuPct = agg1 && agg2 ? busyPct(agg1, agg2) : 0
  const perCore: CpuCore[] = []
  for (const [label, a] of stat1) {
    if (label === "cpu") continue
    const b = stat2.get(label)
    if (!b) continue
    perCore.push({ idx: parseInt(label.replace("cpu", ""), 10) || 0, pct: busyPct(a, b) })
  }
  perCore.sort((a, b) => a.idx - b.idx)

  // Memory (values in /proc/meminfo are kB).
  const mem: Record<string, number> = {}
  for (const line of s.MEM || []) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/)
    if (m) mem[m[1]] = parseInt(m[2], 10) * 1024
  }
  const memTotal = mem.MemTotal || 0
  const memAvailable = mem.MemAvailable ?? mem.MemFree ?? 0
  const memUsed = Math.max(0, memTotal - memAvailable)
  const swapTotal = mem.SwapTotal || 0
  const swapUsed = Math.max(0, swapTotal - (mem.SwapFree || 0))

  // Disk mounts from `df -B1`.
  const disks: DiskMount[] = []
  for (const line of s.DF || []) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6 || parts[0] === "Filesystem") continue
    const total = parseInt(parts[1], 10)
    const used = parseInt(parts[2], 10)
    const mount = parts.slice(5).join(" ")
    if (isNaN(total) || isNaN(used) || total <= 0) continue
    disks.push({ mount, total, used, pct: (used / total) * 100 })
  }
  disks.sort((a, b) => b.pct - a.pct)

  // Top processes from ps.
  const processes: ProcInfo[] = []
  for (const line of s.PS || []) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4 || parts[0] === "PID") continue
    const pid = parts[0]
    const mem = parseFloat(parts[parts.length - 1])
    const cpu = parseFloat(parts[parts.length - 2])
    const comm = parts.slice(1, parts.length - 2).join(" ")
    if (isNaN(cpu) || isNaN(mem)) continue
    processes.push({ pid, comm, cpu, mem })
  }

  return {
    host,
    uptimeSecs,
    load,
    cores,
    cpuPct,
    perCore,
    memTotal,
    memUsed,
    memAvailable,
    swapTotal,
    swapUsed,
    disks,
    processes,
    takenAt: Date.now(),
  }
}

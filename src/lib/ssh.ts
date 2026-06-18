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

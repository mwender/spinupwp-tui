// Inspect and provision Linux swap over SSH.
//
// SpinupWP has no swap API. Reads use the normal non-interactive SSH path;
// writes are performed through the existing connected-sudo runner in ssh.ts.

import type { Server, Site } from "../api/types.ts"
import { resolveSshTarget, runSudoServerOp, type SudoServerResult } from "./ssh.ts"
import { SSH_OPTS } from "./probe.ts"

export type SwapKind = "active" | "configured-inactive" | "none"

export interface SwapEntry {
  name: string
  sizeBytes: number
  usedBytes: number
  priority: number
}

export interface SwapStatus {
  kind: SwapKind
  entries: SwapEntry[]
  ramBytes: number | null
  swapfileBytes: number | null
  persistent: boolean
  recommendedGiB: number
}

export type SwapInspectResult =
  | { ok: true; target: string; status: SwapStatus }
  | { ok: false; target: string; error: string }

export const MIN_SWAP_GIB = 1
export const MAX_SWAP_GIB = 64

export function validateSwapSizeGiB(value: number): number | null {
  if (!Number.isInteger(value) || value < MIN_SWAP_GIB || value > MAX_SWAP_GIB) return null
  return value
}

export function recommendedSwapGiB(ramBytes: number | null): number {
  if (!ramBytes || !Number.isFinite(ramBytes) || ramBytes <= 0) return 2
  const ramGiB = ramBytes / (1024 ** 3)
  return Math.min(4, Math.max(1, Math.ceil(ramGiB / 2)))
}

const SWAP_READ_SCRIPT = [
  "echo ===SWAP; swapon --show=NAME,SIZE,USED,PRIO --bytes --noheadings 2>/dev/null || true",
  "echo ===MEM; awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo",
  "echo ===FILE; if [ -f /swapfile ]; then stat -c %s /swapfile 2>/dev/null || true; fi",
  "echo ===FSTAB; grep -Eq '^[[:space:]]*/swapfile[[:space:]]+none[[:space:]]+swap([[:space:]]|$)' /etc/fstab 2>/dev/null && echo yes || echo no",
  "echo ===END",
].join("; ")

export function parseSwapStatus(output: string): SwapStatus {
  const sections: Record<string, string[]> = {}
  let current = ""
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "")
    const marker = line.match(/^===([A-Z]+)$/)
    if (marker) {
      current = marker[1]
      sections[current] = []
    } else if (current) {
      sections[current].push(line)
    }
  }

  const entries: SwapEntry[] = []
  for (const line of sections.SWAP ?? []) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const sizeBytes = Number(parts[1])
    const usedBytes = Number(parts[2])
    const priority = Number(parts[3])
    if (parts[0] && Number.isFinite(sizeBytes) && Number.isFinite(usedBytes)) {
      entries.push({ name: parts[0], sizeBytes, usedBytes, priority: Number.isFinite(priority) ? priority : 0 })
    }
  }
  const ram = Number((sections.MEM?.[0] ?? "").trim())
  const file = Number((sections.FILE?.[0] ?? "").trim())
  const persistent = (sections.FSTAB?.[0] ?? "").trim() === "yes"
  const ramBytes = Number.isFinite(ram) && ram > 0 ? ram : null
  const swapfileBytes = Number.isFinite(file) && file > 0 ? file : null

  return {
    kind: entries.length > 0 ? "active" : swapfileBytes != null || persistent ? "configured-inactive" : "none",
    entries,
    ramBytes,
    swapfileBytes,
    persistent,
    recommendedGiB: recommendedSwapGiB(ramBytes),
  }
}

export async function inspectSwap(server: Server, sites: Site[], sshUser: string | null, sudoUser?: string): Promise<SwapInspectResult> {
  const target = resolveSshTarget(server, sites, sudoUser ?? sshUser)
  if (!target) return { ok: false, target: "(no IP)", error: "Server has no IP address." }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["ssh", ...SSH_OPTS, target, SWAP_READ_SCRIPT], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  } catch (err) {
    return { ok: false, target, error: `Failed to launch ssh: ${(err as Error).message}` }
  }
  const timer = setTimeout(() => {
    try { proc.kill() } catch { /* already gone */ }
  }, 15000)
  const code = await proc.exited
  clearTimeout(timer)
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
  if (code !== 0 || !stdout.includes("===END")) {
    return { ok: false, target, error: stderr.trim().split("\n").slice(-2).join(" ") || `ssh exited with code ${code}` }
  }
  return { ok: true, target, status: parseSwapStatus(stdout) }
}

function sizeBytes(gib: number): number {
  return gib * 1024 ** 3
}

// Active /swapfile can be resized safely by preparing a replacement first,
// briefly swapping it off, then enabling the replacement. Other active swap
// devices are never modified.
export function buildSwapEnsureScript(gib: number): string {
  const valid = validateSwapSizeGiB(gib)
  if (valid == null) throw new Error(`Swap size must be a whole number from ${MIN_SWAP_GIB} to ${MAX_SWAP_GIB} GiB.`)
  const bytes = sizeBytes(valid)
  return [
    "set -e",
    "RESIZED=0",
    "ACTIVE=$(swapon --noheadings --show=NAME 2>/dev/null || true)",
    "if [ -n \"$ACTIVE\" ] && [ \"$ACTIVE\" != /swapfile ]; then echo 'Active swap is not exactly /swapfile; refusing to resize it.' >&2; exit 12; fi",
    "if [ \"$ACTIVE\" = /swapfile ] && [ -f /swapfile ]; then",
    `  CURRENT=$(stat -c %s /swapfile 2>/dev/null || echo 0); if [ \"$CURRENT\" -eq ${bytes} ]; then echo ===SWAP_ALREADY_ACTIVE; echo ===SWAP_VERIFIED; exit 0; fi`,
    "  TMP=/swapfile.spinup-tui.$$; OLD=/swapfile.spinup-tui.old.$$; trap 'rm -f \"$TMP\" \"$OLD\"' EXIT",
    `  fallocate -l ${bytes} \"$TMP\"; chmod 600 \"$TMP\"; chown root:root \"$TMP\"; mkswap \"$TMP\" >/dev/null`,
    "  swapoff /swapfile",
    "  mv /swapfile \"$OLD\"",
    "  if ! mv \"$TMP\" /swapfile; then mv \"$OLD\" /swapfile; swapon /swapfile; exit 13; fi",
    "  if ! swapon /swapfile; then rm -f /swapfile; mv \"$OLD\" /swapfile; swapon /swapfile; exit 14; fi",
    "  rm -f \"$OLD\"; trap - EXIT; RESIZED=1",
    "fi",
    "if [ -e /swapfile ] && [ ! -f /swapfile ]; then echo 'Existing /swapfile is not a regular file.' >&2; exit 10; fi",
    "if [ -f /swapfile ]; then",
    "  TYPE=$(blkid -p -s TYPE -o value /swapfile 2>/dev/null || true)",
    "  if [ \"$TYPE\" != swap ]; then echo 'Existing /swapfile is not a valid swap area.' >&2; exit 11; fi",
    "else",
    `  TMP=/swapfile.spinup-tui.$$; trap 'rm -f \"$TMP\"' EXIT; fallocate -l ${bytes} \"$TMP\"; chmod 600 \"$TMP\"; chown root:root \"$TMP\"; mkswap \"$TMP\" >/dev/null; mv \"$TMP\" /swapfile; trap - EXIT`,
    "fi",
    "chmod 600 /swapfile; chown root:root /swapfile",
    "if [ \"$RESIZED\" -eq 0 ]; then swapon /swapfile; fi",
    "grep -Eq '^[[:space:]]*/swapfile[[:space:]]+none[[:space:]]+swap([[:space:]]|$)' /etc/fstab || printf '%s\\n' '/swapfile none swap sw 0 0' >> /etc/fstab",
    "swapon --noheadings --show=NAME | grep -Fxq /swapfile",
    "grep -Eq '^[[:space:]]*/swapfile[[:space:]]+none[[:space:]]+swap([[:space:]]|$)' /etc/fstab",
    "echo ===SWAP_VERIFIED",
  ].join("\n")
}

export function ensureSwap(
  server: Server,
  opts: { sudoUser: string; sudoPassword: string; gib: number },
): Promise<SudoServerResult> {
  return runSudoServerOp(server, opts, () => buildSwapEnsureScript(opts.gib), "===SWAP_VERIFIED")
}

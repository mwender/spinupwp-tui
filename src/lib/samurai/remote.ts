// Talking to a server's spinuptui-nginx gate. The gate's user has one forced
// command per site key, so whatever we send is just the gate subcommand:
// export, test, allowed, version, hash or deploy.
//
// Only the site's own deploy key is ever offered (IdentitiesOnly, no agent).
// The servers run fail2ban, and offering every key in ~/.ssh and the agent to
// a user that knows none of them is how an IP gets banned.

import { spawn } from "../spawn.ts"
import { SERVER_PATHS } from "./gate.ts"

export interface GateTarget {
  ip: string
  port: number | null
  keyPath: string // this machine's private deploy key for the site
  // Tests only: run this instead of ssh, with the gate command appended (the
  // sandbox runs the real gate script locally).
  command?: string[]
  // Tests only: the sandbox's gate is a rewritten copy, so its hash differs.
  gateSha256?: string
}

export interface GateResult {
  code: number
  stdout: Uint8Array
  stderr: string
}

export function gateSshArgs(t: GateTarget, command: string): string[] {
  return [
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no",
    "-o", "ControlMaster=no",
    "-i", t.keyPath,
    ...(t.port && t.port !== 22 ? ["-p", String(t.port)] : []),
    `${SERVER_PATHS.user}@${t.ip}`,
    command,
  ]
}

// Runs one gate command. stdout is read while the command runs (an export can
// be larger than a pipe's buffer), and kept as bytes: export is a tar.
export async function gateCall(t: GateTarget, command: "export" | "test" | "allowed" | "version" | "hash" | "deploy", stdin?: Uint8Array, timeoutMs = 60_000): Promise<GateResult> {
  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn(t.command ? [...t.command, command] : gateSshArgs(t, command), { stdout: "pipe", stderr: "pipe", stdin: stdin ? "pipe" : "ignore" })
  } catch (e) {
    return { code: -1, stdout: new Uint8Array(), stderr: `Failed to launch ssh: ${(e as Error).message}` }
  }
  const out = new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer()
  const err = new Response(proc.stderr as ReadableStream<Uint8Array>).text()
  if (stdin && proc.stdin) {
    const sink = proc.stdin as { write: (b: Uint8Array) => void; end: () => void }
    sink.write(stdin)
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
  return { code, stdout: new Uint8Array(await out), stderr: await err }
}

export const text = (b: Uint8Array) => new TextDecoder().decode(b).trim()

// The gate's own last line of complaint, or ssh's.
export function gateError(r: GateResult, fallback: string): string {
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean)
  const err = lines.reverse().find((l) => /^ERROR:/.test(l) || /denied|refused|timed out|not registered|Could not resolve/i.test(l))
  return (err ?? lines[0] ?? fallback).replace(/^ERROR:\s*/, "")
}

// The spinuptui-nginx gate: the one piece of root-owned code Samurai installs
// on a server, and the installer that registers sites with it. Both are shell
// scripts in ./server, embedded here as text so the npm package and the
// standalone binary carry exactly the same bytes.
//
// The hashes are pinned: SpinupTUI installs only this gate and, before each
// push, refuses a server whose gate reports a different version or hash.
// Changing either script fails gate.test.ts until the pin is updated, which
// is the point: a root script never changes by accident.

import { createHash } from "node:crypto"
import gateScript from "./server/spinuptui-nginx" with { type: "text" }
import installScript from "./server/install.sh" with { type: "text" }

export const GATE_VERSION = "2.0.0"
export const GATE_SHA256 = "7029dff3c15d10ea766971c2b86aa44d653055a9ac678267788d26a86ac21d44"
export const INSTALLER_SHA256 = "38b575c5af1c216d83f5616bfdbcd699784cb7e329a007fd1d4644a352f2bca3"

// Where install.sh puts things on the server. Named for SpinupTUI, and for
// what the gate may touch (nginx), so it never reads as SpinupWP's own.
export const SERVER_PATHS = {
  gate: "/usr/local/sbin/spinuptui-nginx",
  sudoers: "/etc/sudoers.d/spinuptui-nginx",
  conf: "/etc/spinuptui/nginx",
  sites: "/etc/spinuptui/nginx/sites",
  backups: "/var/backups/spinuptui/nginx",
  user: "spinuptui-nginx",
  home: "/home/spinuptui-nginx",
} as const

export const GATE_FILE = "spinuptui-nginx"
export const INSTALLER_FILE = "install.sh"

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function gateScriptText(): string {
  return gateScript
}

export function installerText(): string {
  return installScript
}

// What a server's gate reported, against what this SpinupTUI ships.
export type GateCheck = { ok: true } | { ok: false; reason: "missing" | "version" | "hash"; message: string }

export function checkGate(reported: { version: string | null; hash: string | null }, expectedHash = GATE_SHA256): GateCheck {
  if (!reported.version) return { ok: false, reason: "missing", message: "The spinuptui-nginx gate isn't installed on this server." }
  if (reported.version.trim() !== GATE_VERSION) return { ok: false, reason: "version", message: `The server's gate is version ${reported.version.trim()}; this SpinupTUI needs ${GATE_VERSION}. Run Samurai's setup for the site again to upgrade it.` }
  if (reported.hash?.trim() !== expectedHash) return { ok: false, reason: "hash", message: "The server's gate isn't the one SpinupTUI installed: its contents differ. Samurai won't push through it until setup is run again." }
  return { ok: true }
}

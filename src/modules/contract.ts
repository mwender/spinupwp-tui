// The module contract (docs/2026-10-16_beacon-and-module-contract-spec.md).
//
// A module is a feature that keeps working after the TUI is closed. Each one
// describes itself with a ModuleDefinition so `spinuptui modules`, the future
// Modules screen and `station setup` are views over the same data rather than
// knowing every module by hand.
//
// Rules the shape encodes:
// - Config is a machine-level top-level key in config.json named after the
//   module, written only by deliberate setup commands.
// - Anything a module writes while running goes in its state directory, never
//   config.json (whose writes are neither atomic nor locked).
// - The user's work (jobs, reports, write-ups — anything a person reads, keeps
//   or shares) goes in its work directory, ~/SpinupTUI/<id>/, not next to the
//   tokens in the hidden config directory.
// - Recurring work is declared in `jobs` for Scheduler to run; a module never
//   installs an OS scheduler unit of its own.
// - status() is computed on demand, is cheap, and never sends anything.

import { homedir } from "node:os"
import { join } from "node:path"
import { configDir, loadConfig } from "../config.ts"

export type ModuleId = "beacon" | "scheduler" | "sentinel" | "samurai"

export interface ScheduledJobDecl {
  id: string // e.g. "sentinel.tick"
  every?: string // e.g. "5m"
  at?: string // e.g. "08:00"
  // A spinuptui subcommand's arguments, never a path into a checkout.
  command: string[]
}

export interface ModuleCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ModuleStatus {
  id: ModuleId
  state: "not_configured" | "ok" | "degraded"
  summary: string
  checks: ModuleCheck[]
  remedy?: string
}

export interface ModuleDefinition {
  id: ModuleId
  name: string
  // Outcome copy, shared with the landing page's module card.
  summary: string
  dependsOn: ModuleId[]
  configKey: string
  // Machine state: locks, logs, high-water marks.
  stateDir(): string
  // The user's work. Created on first use, never at install.
  workDir(): string
  jobs: ScheduledJobDecl[]
  status(): Promise<ModuleStatus>
}

export function moduleStateDir(id: ModuleId): string {
  return join(configDir(), "modules", id)
}

const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p)

// ~/SpinupTUI by default: visible and easy to back up or turn into a git
// repository. Deliberately not ~/Documents, which iCloud may sync (a second
// syncer writing inside a .git corrupts it).
export function spinuptuiHome(): string {
  const p = process.env.SPINUPTUI_HOME?.trim() || loadConfig().homeDir || join(homedir(), "SpinupTUI")
  return expandHome(p)
}

export function moduleWorkDir(id: ModuleId): string {
  return join(spinuptuiHome(), id)
}

// A module that hasn't shipped yet: just enough to draw its card.
export type UpcomingModule = Pick<ModuleDefinition, "id" | "name" | "summary" | "dependsOn">

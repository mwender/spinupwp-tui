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
// - Recurring work is declared in `jobs` for Scheduler to run; a module never
//   installs an OS scheduler unit of its own.
// - status() is computed on demand, is cheap, and never sends anything.

import { join } from "node:path"
import { configDir } from "../config.ts"

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
  stateDir(): string
  jobs: ScheduledJobDecl[]
  status(): Promise<ModuleStatus>
}

export function moduleStateDir(id: ModuleId): string {
  return join(configDir(), "modules", id)
}

// A module that hasn't shipped yet: just enough to draw its card.
export type UpcomingModule = Pick<ModuleDefinition, "id" | "name" | "summary" | "dependsOn">

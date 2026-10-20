// Every module SpinupTUI ships, in dependency order, plus the ones still to come
// (shown as "coming soon" on the Modules screen and in `spinuptui modules`).

import type { ModuleDefinition, UpcomingModule } from "./contract.ts"
import { beaconModule } from "./beacon.ts"
import { schedulerModule } from "./scheduler.ts"

export const MODULES: ModuleDefinition[] = [beaconModule, schedulerModule]

// Outcome copy only — the same lines feed the landing page. An entry moves to
// MODULES (and out of here) when the module ships.
export const UPCOMING_MODULES: UpcomingModule[] = [
  {
    id: "sentinel",
    name: "Sentinel",
    summary: "Watches the fleet, works out what actually broke, and writes it up.",
    dependsOn: ["beacon", "scheduler"],
  },
  {
    id: "samurai",
    name: "Samurai",
    summary: "Defends your sites at the nginx layer, proactively and when Sentinel spots an attack, with your approval.",
    dependsOn: ["beacon", "scheduler", "sentinel"],
  },
]

export async function allModuleStatuses() {
  return Promise.all(MODULES.map(async (m) => ({ name: m.name, about: m.summary, dependsOn: m.dependsOn, ...(await m.status()) })))
}

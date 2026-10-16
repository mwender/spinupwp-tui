// Every module SpinupTUI ships, in dependency order.

import type { ModuleDefinition } from "./contract.ts"
import { beaconModule } from "./beacon.ts"

export const MODULES: ModuleDefinition[] = [beaconModule]

export async function allModuleStatuses() {
  return Promise.all(MODULES.map(async (m) => ({ name: m.name, about: m.summary, dependsOn: m.dependsOn, ...(await m.status()) })))
}

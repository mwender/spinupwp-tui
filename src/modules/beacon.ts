// Beacon's module declaration: the first implementation of the contract.

import { loadConfig } from "../config.ts"
import { beaconFromConfig, lastSendLogEntry, maskChatId, maskToken } from "../lib/beacon.ts"
import { listenerHealth } from "../lib/beaconListenInstall.ts"
import { moduleStateDir, moduleWorkDir, type ModuleCheck, type ModuleDefinition, type ModuleStatus } from "./contract.ts"

export const beaconModule: ModuleDefinition = {
  id: "beacon",
  name: "Beacon",
  summary: "Tells you when something needs you: one pager for the fleet and every module.",
  dependsOn: [],
  configKey: "beacon",
  stateDir: () => moduleStateDir("beacon"),
  workDir: () => moduleWorkDir("beacon"),
  // The listener's alive check: exits 1 while an installed listener isn't
  // polling, so Scheduler pages once when it stops and once when it's back.
  jobs: [{ id: "beacon.listener", every: "5m", command: ["beacon", "listener", "check"] }],
  async status(): Promise<ModuleStatus> {
    const beacon = beaconFromConfig(loadConfig())
    if (beacon.channels.length === 0) {
      return {
        id: "beacon",
        state: "not_configured",
        summary: "No channels configured",
        checks: [],
        remedy: "spinuptui beacon add telegram <name> --env-file <path>",
      }
    }
    const checks: ModuleCheck[] = beacon.channels.map((c) => ({
      name: `channel ${c.name}`,
      ok: true,
      detail: `telegram bot ${maskToken(c.channel.botToken)} → chat ${maskChatId(c.channel.chatId)}${c.env ? " (from environment)" : ""}${c.name === beacon.defaultChannel ? ", default" : ""}`,
    }))
    checks.push({
      name: "default channel",
      ok: beacon.defaultChannel !== null,
      detail: beacon.defaultChannel ?? "none — senders must pass --to",
    })
    const listener = listenerHealth()
    checks.push(listener ? { name: "listener", ...listener } : { name: "listener", ok: true, detail: "not installed: the pager sends but doesn't answer" })
    const last = lastSendLogEntry()
    checks.push({
      name: "last send",
      ok: last?.ok ?? true,
      detail: last ? `${last.ok ? "delivered" : `failed (${last.error})`} via ${last.channel} at ${last.at}` : "nothing sent yet",
    })
    const failing = checks.find((c) => !c.ok)
    return {
      id: "beacon",
      state: failing ? "degraded" : "ok",
      summary: failing ? `${failing.name}: ${failing.detail}` : `${beacon.channels.length} channel${beacon.channels.length === 1 ? "" : "s"}, default ${beacon.defaultChannel}`,
      checks,
      ...(failing ? { remedy: "spinuptui beacon test" } : {}),
    }
  },
}

// Configuration resolution + persistence.
//
// Token resolution order (first match wins):
//   1. SPINUPWP_ACCESS_TOKEN environment variable (Bun auto-loads ./.env)
//   2. ~/.config/spinupwp-tui/config.json  (written by the onboarding wizard)
//
// This lets the original author keep a project-local .env while letting other
// users configure the tool globally after a `bun install -g`.

import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir, chmod } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import type { LocalLink } from "./lib/local.ts"

export const DEFAULT_BASE_URL = "https://api.spinupwp.app/v1"

export interface AppConfig {
  token: string
  baseUrl: string
  tokenSource: "env" | "file" | "none"
  // Optional override for the SSH user used by the server health view. When unset,
  // the health view derives the user from a site on the server (its `site_user`).
  sshUser: string | null
  // SpinupWP account/team slug (e.g. "wenmark-digital-solutions"), used to build
  // deep links into the SpinupWP web app. The API doesn't expose it, so it's
  // configured. When unset, deep links fall back to the dashboard root.
  accountSlug: string | null
  // macOS terminal app to open for local working copies (e.g. "iTerm", "Warp").
  // When unset, inferred from $TERM_PROGRAM, falling back to Terminal.
  terminalApp: string | null
  // Directories to (eventually) scan for local working copies. Reserved for the
  // Phase 2 auto-discovery pass; unused by Phase 1's manual linking.
  localRoots: string[]
  // Local working-copy links, keyed by SpinupWP site id (as a string, since
  // JSON object keys are strings). See lib/local.ts for the link shape.
  localSites: Record<string, LocalLink>
}

export interface StoredConfig {
  token?: string
  baseUrl?: string
  sshUser?: string
  accountSlug?: string
  terminalApp?: string
  localRoots?: string[]
  localSites?: Record<string, LocalLink>
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "spinupwp-tui") : join(homedir(), ".config", "spinupwp-tui")
}

export function configPath(): string {
  return join(configDir(), "config.json")
}

function readStoredConfig(): StoredConfig {
  try {
    const path = configPath()
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, "utf8")) as StoredConfig
  } catch {
    return {}
  }
}

// Resolve the active config from env + stored file. Never throws.
export function loadConfig(): AppConfig {
  const stored = readStoredConfig()
  const envToken = process.env.SPINUPWP_ACCESS_TOKEN?.trim()
  const fileToken = stored.token?.trim()

  const token = envToken || fileToken || ""
  const tokenSource: AppConfig["tokenSource"] = envToken ? "env" : fileToken ? "file" : "none"

  return {
    token,
    baseUrl: (stored.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    tokenSource,
    sshUser: process.env.SPINUPWP_SSH_USER?.trim() || stored.sshUser?.trim() || null,
    accountSlug: process.env.SPINUPWP_ACCOUNT_SLUG?.trim() || stored.accountSlug?.trim() || null,
    terminalApp: process.env.SPINUPWP_TERMINAL_APP?.trim() || stored.terminalApp?.trim() || null,
    localRoots: stored.localRoots ?? [],
    localSites: stored.localSites ?? {},
  }
}

export function hasToken(): boolean {
  return loadConfig().token.length > 0
}

// Persist a token (and optional base URL) to the config file. Used by onboarding.
export async function saveConfig(partial: StoredConfig): Promise<void> {
  const dir = configDir()
  await mkdir(dir, { recursive: true })
  const current = readStoredConfig()
  const next: StoredConfig = { ...current, ...partial }
  const path = configPath()
  await Bun.write(path, JSON.stringify(next, null, 2) + "\n")
  // The file holds an API token — restrict it to the owner.
  try {
    await chmod(path, 0o600)
  } catch {
    // Best-effort (e.g. on filesystems without POSIX perms).
  }
}

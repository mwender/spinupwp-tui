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
import { ALL_PROVIDERS, type Connection, type ConnProvider } from "./lib/providers.ts"

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
  // Opt-in for the production→local DB sync (`p`). Off by default because it
  // OVERWRITES the local database and assumes a working local WP dev environment
  // (WP-CLI + a local DB). The read-only DB backup (`d`) needs neither and stays
  // available without this. Set "localSync": true in config to enable.
  localSync: boolean
  // Directories to (eventually) scan for local working copies. Reserved for the
  // Phase 2 auto-discovery pass; unused by Phase 1's manual linking.
  localRoots: string[]
  // Local working-copy links, keyed by SpinupWP site id (as a string, since
  // JSON object keys are strings). See lib/local.ts for the link shape.
  localSites: Record<string, LocalLink>
  // DNS provider connections (Phase 2 access detection), keyed by provider, merged
  // from the stored config and the environment. Env-sourced connections carry
  // `env: true` and are read-only in the UI. Secrets live here (file is chmod 600).
  providerConnections: Record<ConnProvider, Connection[]>
}

// Stored connection (no `provider`/`env` discriminators — added on load).
export interface StoredConnection {
  id: string
  label: string
  creds: Record<string, string>
}
export type StoredProviders = Partial<Record<ConnProvider, StoredConnection[]>>

// Read a connection's creds, migrating the pre-registry shape (credentials stored
// as inline fields) to the `creds` bag. The migrated bag is rewritten to disk on
// the next saveConfig (add/remove a connection).
function migrateCreds(provider: ConnProvider, c: Record<string, unknown>): Record<string, string> {
  if (c.creds && typeof c.creds === "object") return c.creds as Record<string, string>
  if (provider === "aws") {
    return {
      accessKeyId: String(c.accessKeyId ?? ""),
      secretAccessKey: String(c.secretAccessKey ?? ""),
      region: String(c.region ?? ""),
    }
  }
  if (provider === "cloudflare") return { token: String(c.token ?? "") }
  if (provider === "godaddy") return { apiKey: String(c.apiKey ?? ""), apiSecret: String(c.apiSecret ?? "") }
  return {}
}

export interface StoredConfig {
  token?: string
  baseUrl?: string
  sshUser?: string
  accountSlug?: string
  terminalApp?: string
  localRoots?: string[]
  localSites?: Record<string, LocalLink>
  localSync?: boolean
  providers?: StoredProviders
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

  // Provider connections: stored ones first (per provider), with env-derived ones
  // prepended as read-only "env" connections (consistent with the env token above).
  const sp = stored.providers ?? {}
  const providerConnections = {} as Record<ConnProvider, Connection[]>
  for (const provider of ALL_PROVIDERS) {
    providerConnections[provider] = (sp[provider] ?? []).map((c) => ({
      id: c.id,
      provider,
      label: c.label,
      creds: migrateCreds(provider, c as unknown as Record<string, unknown>),
    }))
  }
  const cfEnv = process.env.CLOUDFLARE_API_TOKEN?.trim()
  if (cfEnv) providerConnections.cloudflare.unshift({ id: "cloudflare-env", provider: "cloudflare", label: "env", creds: { token: cfEnv }, env: true })
  const awsKey = process.env.AWS_ACCESS_KEY_ID?.trim()
  const awsSecret = process.env.AWS_SECRET_ACCESS_KEY?.trim()
  if (awsKey && awsSecret) {
    providerConnections.aws.unshift({
      id: "aws-env",
      provider: "aws",
      label: "env",
      creds: { accessKeyId: awsKey, secretAccessKey: awsSecret, region: process.env.AWS_REGION?.trim() || "" },
      env: true,
    })
  }
  const gdKey = process.env.GODADDY_API_KEY?.trim()
  const gdSecret = process.env.GODADDY_API_SECRET?.trim()
  if (gdKey && gdSecret) {
    providerConnections.godaddy.unshift({ id: "godaddy-env", provider: "godaddy", label: "env", creds: { apiKey: gdKey, apiSecret: gdSecret }, env: true })
  }

  return {
    token,
    baseUrl: (stored.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    tokenSource,
    sshUser: process.env.SPINUPWP_SSH_USER?.trim() || stored.sshUser?.trim() || null,
    accountSlug: process.env.SPINUPWP_ACCOUNT_SLUG?.trim() || stored.accountSlug?.trim() || null,
    terminalApp: process.env.SPINUPWP_TERMINAL_APP?.trim() || stored.terminalApp?.trim() || null,
    localSync: ((): boolean => {
      // Env overrides the file when present; otherwise the stored flag (default off).
      const env = process.env.SPINUPWP_LOCAL_SYNC?.trim()
      if (env != null && env !== "") return /^(1|true|yes|on)$/i.test(env)
      return stored.localSync === true
    })(),
    localRoots: stored.localRoots ?? [],
    localSites: stored.localSites ?? {},
    providerConnections,
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

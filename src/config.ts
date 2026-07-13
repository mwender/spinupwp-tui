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
  // How new Bedrock clone destinations authenticate to Git. "server" assumes
  // the destination server's SSH key is authorized on the user's Git account;
  // "deploy-key" uses the stricter per-repository onboarding flow.
  cloneGitAuth: "server" | "deploy-key"
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
  // SpinupWP server-provider connections, keyed by provider name
  // (digitalocean | vultr | linode | hetzner). The API exposes no endpoint to
  // list these, so — like accountSlug — the id is configured. Required to create
  // a server on that provider (POST /servers needs server_provider[id]). Find the
  // id in SpinupWP → Account Settings → Server Providers.
  serverProviders: Record<string, ServerProviderRef>
  // In-flight resumable jobs, keyed by job id. Hydrated at startup so a build
  // (e.g. a server provision) keeps its tracker across a quit/relaunch.
  jobs: Record<string, StoredJob>
  // Per-server sudo user for privileged writes-over-SSH (e.g. dropping Spinup's
  // machine key into a site user's authorized_keys), keyed by server id (string,
  // since JSON object keys are strings). Only the username is stored — the sudo
  // PASSWORD is held in-memory for the session and (opt-in, macOS) the Keychain,
  // never config.json. `keychain: true` flags that a password is saved in Keychain.
  sudoUsers: Record<string, { user: string; keychain?: boolean }>
  // The public keys (by key body, the base64 second field) the user last chose to
  // grant. Pre-selected in the grant-key picker so they don't re-pick every time.
  preferredGrantKeys: string[]
  // Keys Spinup has granted, keyed by site id (string) → key bodies. Drives the
  // "has Spinup's key" row badge and informs revoke. Optimistic (a record of what
  // Spinup wrote, not a live probe); revoke removes entries.
  grantedKeys: Record<string, string[]>
  // Per-zone access-note OVERRIDES only, keyed by zone apex. A provider's
  // `defaultAccessNote` (e.g. GoDaddy's "Delegate Access") is the assumed normal
  // case and is never stored here — only the exceptions (e.g. "Integracon", a
  // third-party IT contact) are, so this stays empty for the common case.
  zoneAccessNotes: Record<string, string>
  // Uptime Kuma connection (optional). Creds live here like provider creds (file
  // is chmod 600); `jwt` is captured after the first successful login so later
  // sessions use loginByToken (survives 2FA accounts, skips re-sending the
  // password). Env overrides: SPINUP_KUMA_URL / _USERNAME / _PASSWORD.
  uptimeKuma: UptimeKumaConn | null
  // Kuma monitors Spinup has registered, keyed by site domain. `pushToken` is the
  // token baked into the server-side cron; ids let later features pause/verify.
  kumaMonitors: Record<string, KumaMonitorRef>
  // Per-vanity-site health keys, keyed by domain — the `key` the seeded page's
  // ?format=json mode requires (baked in at seed time). Kept here so re-seeds
  // reuse the same key (monitor URLs stay stable) and so monitor-registration
  // features can build the JSON URL later. Letters/digits only.
  vanityHealthKeys: Record<string, string>
  // The last app version the user actually saw the Release Notes overlay for
  // (or, on a fresh install / pre-this-feature upgrade, silently seeded to the
  // running version with no notes shown — nothing meaningful to announce). A
  // mismatch against the running version is what triggers the overlay.
  lastSeenVersion: string | null
}

export interface ServerProviderRef {
  id: number
  databaseProviderId?: number
}

export interface UptimeKumaConn {
  url: string
  username: string
  password: string
  jwt?: string
  env?: boolean // creds came from the environment — read-only in the UI
}

// CONVENTION: every numeric field ending in `Id` is a Kuma monitor id belonging
// to this site, and the alert wiring (`n` in the monitoring overlay) attaches/
// detaches notification providers across ALL of them by that naming rule — a
// new monitor kind only needs a `fooId?: number` field here to be included.
// Don't add a numeric `*Id` field that isn't a monitor id.
export interface KumaMonitorRef {
  healthId?: number // HTTP monitor on /?healthz
  pushId?: number // push monitor fed by the server-side load cron
  pushToken?: string
  redisId?: number // "{server} redis" push monitor fed by the cron's redis-cli ping (vanity/server domains)
  redisToken?: string
  fatalId?: number // "{server} php-fatal" server-wide sentinel fed by the root cron's error/debug.log tail (vanity/server domains)
  fatalToken?: string
  bypassId?: number // "{domain} cache-bypass" opt-in http monitor with a page-cache-bypass Cookie header (per-site, no token — Kuma polls it directly)
  fingerprintId?: number // keyword monitor asserting the front page serves its own template
  // What fingerprint calibration derived (lib/siteFingerprint.ts) — shown in the
  // overlay and kept so a recalibration can explain what it's replacing.
  // `interval` is the check window in seconds.
  fingerprint?: { keyword: string; kind: string; detail: string; interval: number; derivedAt: string }
}

// A long-running, fire-and-forget job persisted across restarts so the app can
// resume tracking it (see docs/2026-06-24_clone-to-server-spec.md "Resumable
// jobs"). `eventId` is the resume key — the SpinupWP event we re-attach a poller
// to on startup. `inputs` is the kind-specific payload needed to continue/retry
// (e.g. { hostname } for a server create). Only in-flight jobs are persisted;
// they're removed once terminal.
export interface StoredJob {
  id: string
  kind: string
  status: string
  step?: string
  failedStep?: string
  error?: string
  startedAt: number
  eventId?: number
  inputs?: unknown
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
  cloneGitAuth?: "server" | "deploy-key"
  providers?: StoredProviders
  serverProviders?: Record<string, ServerProviderRef>
  jobs?: Record<string, StoredJob>
  sudoUsers?: Record<string, { user: string; keychain?: boolean }>
  preferredGrantKeys?: string[]
  grantedKeys?: Record<string, string[]>
  zoneAccessNotes?: Record<string, string>
  vanityHealthKeys?: Record<string, string>
  uptimeKuma?: UptimeKumaConn
  kumaMonitors?: Record<string, KumaMonitorRef>
  lastSeenVersion?: string
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg ? join(xdg, "spinupwp-tui") : join(homedir(), ".config", "spinupwp-tui")
}

export function configPath(): string {
  return join(configDir(), "config.json")
}

// Where Spinup's dedicated machine keypair (spinup-tui[.pub]) lives. Generated
// lazily on first privileged use (see lib/ssh.ts ensureSpinupKey).
export function keysDir(): string {
  return join(configDir(), "keys")
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
    cloneGitAuth: stored.cloneGitAuth === "deploy-key" ? "deploy-key" : "server",
    localRoots: stored.localRoots ?? [],
    localSites: stored.localSites ?? {},
    providerConnections,
    serverProviders: stored.serverProviders ?? {},
    jobs: stored.jobs ?? {},
    sudoUsers: stored.sudoUsers ?? {},
    preferredGrantKeys: stored.preferredGrantKeys ?? [],
    grantedKeys: stored.grantedKeys ?? {},
    zoneAccessNotes: stored.zoneAccessNotes ?? {},
    vanityHealthKeys: stored.vanityHealthKeys ?? {},
    uptimeKuma: ((): UptimeKumaConn | null => {
      const url = process.env.SPINUP_KUMA_URL?.trim()
      const username = process.env.SPINUP_KUMA_USERNAME?.trim()
      const password = process.env.SPINUP_KUMA_PASSWORD?.trim()
      if (url && username && password) return { url: url.replace(/\/+$/, ""), username, password, env: true }
      return stored.uptimeKuma ?? null
    })(),
    kumaMonitors: stored.kumaMonitors ?? {},
    lastSeenVersion: stored.lastSeenVersion?.trim() || null,
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

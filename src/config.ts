// Configuration resolution + persistence.
//
// Token resolution order (first match wins):
//   1. SPINUPWP_ACCESS_TOKEN environment variable (Bun auto-loads ./.env)
//   2. ~/.config/spinupwp-tui/config.json  (written by the onboarding wizard)
//
// This lets the original author keep a project-local .env while letting other
// users configure the tool globally after a `bun install -g`.
//
// Accounts (profiles): config.json can hold several SpinupWP accounts under
// `profiles`, one of them active. Everything that belongs to an account — its
// token, DNS connections, local-copy links, sudo users, jobs… (PROFILE_KEYS) —
// lives inside its profile; machine-level settings (terminal app, local scan
// roots, the Uptime Kuma login, last-seen version) stay at the top level and are
// shared. Callers never see the split: readStoredConfig() returns the active
// profile flattened over the globals, and saveConfig() routes each key back to
// where it belongs. A pre-profiles file is read as a single profile, "default",
// and rewritten in the new shape on its next save.

import { homedir } from "node:os"
import { join } from "node:path"
import { mkdir, chmod } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import type { LocalLink } from "./lib/local.ts"
import { ALL_PROVIDERS, type Connection, type ConnProvider } from "./lib/providers.ts"

export const DEFAULT_BASE_URL = "https://api.spinupwp.app/v1"

export interface AppConfig {
  // The active account's profile id and human label (see "Accounts" above).
  profileId: string
  profileLabel: string
  token: string
  baseUrl: string
  tokenSource: "env" | "file" | "none"
  // Optional override for the SSH user used by the server health view. When unset,
  // the health view derives the user from a site on the server (its `site_user`).
  sshUser: string | null
  // SpinupWP account/team slug (e.g. "acme-agency"), used to build
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

// ---- Accounts (profiles) -------------------------------------------------------

// The keys that belong to one SpinupWP account. Server and site ids are assigned
// per account (two accounts can both have a server #42), so anything keyed by
// them MUST be here, as must DNS provider credentials (each client's own).
// Everything else in StoredConfig is machine-level and shared by every profile.
// `kumaMonitors` is per account, the Kuma login (`uptimeKuma`) is shared: one
// agency's Kuma watches every account's sites.
const PROFILE_KEYS = [
  "token",
  "baseUrl",
  "accountSlug",
  "sshUser",
  "localSites",
  "localSync",
  "providers",
  "serverProviders",
  "jobs",
  "sudoUsers",
  "preferredGrantKeys",
  "grantedKeys",
  "zoneAccessNotes",
  "vanityHealthKeys",
  "kumaMonitors",
] as const satisfies readonly (keyof StoredConfig)[]
type ProfileKey = (typeof PROFILE_KEYS)[number]
const isProfileKey = (k: string): k is ProfileKey => (PROFILE_KEYS as readonly string[]).includes(k)

export type StoredProfile = Pick<StoredConfig, ProfileKey> & { label?: string }

// The on-disk shape: globals at the top, accounts under `profiles`.
interface StoredFile extends Omit<StoredConfig, ProfileKey> {
  activeProfile?: string
  profiles?: Record<string, StoredProfile>
}

// The profile a pre-profiles config migrates into. Its Keychain entries and cache
// files keep their original (un-namespaced) names, so migrating moves nothing.
export const DEFAULT_PROFILE = "default"

export interface ProfileSummary {
  id: string
  label: string
  accountSlug: string | null
  active: boolean
  // How many sudo passwords this account has saved in the Keychain — what a
  // removal will scrub.
  keychainServers: number[]
}

// Picks a profile for this process only (no write) — the SPINUPTUI_ACCOUNT env
// var, so a CLI command can target an account without switching the app's.
let processProfile: string | null = process.env.SPINUPTUI_ACCOUNT?.trim() || null

export function profileLabel(p: StoredProfile | undefined, id: string): string {
  return p?.label?.trim() || p?.accountSlug?.trim() || id
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

function readRawFile(): Record<string, unknown> {
  try {
    const path = configPath()
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

// Read config.json in the profiles shape, migrating a flat (pre-profiles) file
// in memory: its account keys become the "default" profile.
function readStoredFile(): StoredFile {
  const raw = readRawFile()
  if (raw.profiles && typeof raw.profiles === "object") return raw as StoredFile
  const file: Record<string, unknown> = {}
  const profile: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) (isProfileKey(k) ? profile : file)[k] = v
  // Nothing account-shaped yet (fresh install): no profile until one is saved.
  if (Object.keys(profile).length === 0) return file as StoredFile
  return { ...(file as StoredFile), activeProfile: DEFAULT_PROFILE, profiles: { [DEFAULT_PROFILE]: profile as StoredProfile } }
}

// The id of the profile this process reads and writes. Falls back to the first
// profile when the stored pointer is missing or dangling.
function resolveActive(file: StoredFile): string {
  const ids = Object.keys(file.profiles ?? {})
  for (const want of [processProfile, file.activeProfile]) if (want && ids.includes(want)) return want
  return ids[0] ?? DEFAULT_PROFILE
}

export function activeProfileId(): string {
  return resolveActive(readStoredFile())
}

// The active profile flattened over the machine-level settings — the shape every
// caller has always read.
function readStoredConfig(): StoredConfig {
  const file = readStoredFile()
  const { profiles, activeProfile: _active, ...globals } = file
  const profile = profiles?.[resolveActive(file)] ?? {}
  const { label: _label, ...fields } = profile
  return { ...globals, ...fields }
}

// Where an account's disk caches (probe results, DNS, verified zones) live. The
// default profile keeps the original top-level paths, so migrating moves no
// files; any other account gets its own directory, since those caches are keyed
// by per-account site ids and zones.
export function profileDataDir(id = activeProfileId()): string {
  return id === DEFAULT_PROFILE ? configDir() : join(configDir(), "profiles", id)
}

// The per-account cache files, by name, inside profileDataDir() — listed so
// removing an account can delete exactly these (the default profile's sit
// beside machine-level files in the config dir itself).
export const PROFILE_CACHE_FILES = ["stack-cache.json", "dns-cache.json", "providers-cache.json"]

export function listProfiles(): ProfileSummary[] {
  const file = readStoredFile()
  const active = resolveActive(file)
  return Object.entries(file.profiles ?? {}).map(([id, p]) => ({
    id,
    label: profileLabel(p, id),
    accountSlug: p.accountSlug?.trim() || null,
    active: id === active,
    keychainServers: Object.entries(p.sudoUsers ?? {})
      .filter(([, u]) => u.keychain)
      .map(([sid]) => Number(sid)),
  }))
}

// A lowercase, dash-separated id from a label, unique among existing profiles.
function profileIdFor(label: string, taken: string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "account"
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

// Add an account (token already validated by the caller). Does not switch to it.
export async function addProfile(p: { label: string; token: string; baseUrl?: string; accountSlug?: string }): Promise<string> {
  const file = readStoredFile()
  const profiles = { ...(file.profiles ?? {}) }
  const id = profileIdFor(p.label, Object.keys(profiles))
  profiles[id] = {
    label: p.label.trim(),
    token: p.token.trim(),
    baseUrl: p.baseUrl ?? DEFAULT_BASE_URL,
    ...(p.accountSlug?.trim() ? { accountSlug: p.accountSlug.trim() } : {}),
  }
  await writeStoredFile({ ...file, activeProfile: resolveActive(file), profiles })
  return id
}

export async function renameProfile(id: string, label: string): Promise<void> {
  const file = readStoredFile()
  const p = file.profiles?.[id]
  if (!p || !label.trim()) return
  await writeStoredFile({ ...file, activeProfile: resolveActive(file), profiles: { ...file.profiles, [id]: { ...p, label: label.trim() } } })
}

// Drop an account's profile. The caller scrubs its Keychain entries and cache
// directory (see removeAccount in the Accounts overlay). The active account
// can't be removed — switch away first.
export async function removeProfile(id: string): Promise<void> {
  const file = readStoredFile()
  const active = resolveActive(file)
  if (id === active || !file.profiles?.[id]) return
  const { [id]: _gone, ...rest } = file.profiles
  await writeStoredFile({ ...file, activeProfile: active, profiles: rest })
}

// Lock this process to the account active right now. The TUI calls it at
// launch: without it, a second instance on the same machine
// switching accounts would rewrite `activeProfile` in the shared file, and this
// process's call-time reads — Keychain names, cache dirs, jobs, local links —
// would quietly follow it while its screens still show the old account.
export function pinActiveProfile(): string {
  processProfile = resolveActive(readStoredFile())
  return processProfile
}

// Make `id` the active account, for this process and future launches.
export async function setActiveProfile(id: string): Promise<void> {
  const file = readStoredFile()
  if (!file.profiles?.[id]) return
  processProfile = id
  await writeStoredFile({ ...file, activeProfile: id })
}

// Resolve the active config from env + stored file. Never throws.
export function loadConfig(): AppConfig {
  const stored = readStoredConfig()
  const file = readStoredFile()
  const profileId = resolveActive(file)
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
    profileId,
    profileLabel: profileLabel(file.profiles?.[profileId], profileId),
    token,
    baseUrl: (stored.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    tokenSource,
    sshUser: process.env.SPINUPWP_SSH_USER?.trim() || stored.sshUser?.trim() || null,
    // The env slug describes the env token's account (or the one account a
    // pre-profiles setup had) — never another profile the user switched to.
    accountSlug:
      ((tokenSource === "env" || profileId === DEFAULT_PROFILE) && process.env.SPINUPWP_ACCOUNT_SLUG?.trim()) || stored.accountSlug?.trim() || null,
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

// Merge settings into the config file: account keys into the active profile
// (created as "default" if there is none yet — first-run onboarding), the rest
// at the top level. `profileId` pins the account keys to a specific profile —
// the app passes the one it was started for, so a write that lands after an
// account switch can't leak into the newly active account (and one for an
// account removed meanwhile is dropped).
export async function saveConfig(partial: StoredConfig, profileId?: string): Promise<void> {
  const file = readStoredFile()
  const active = resolveActive(file)
  if (profileId && profileId !== active && !file.profiles?.[profileId]) {
    partial = Object.fromEntries(Object.entries(partial).filter(([k]) => !isProfileKey(k)))
    if (Object.keys(partial).length === 0) return
  }
  const target = profileId && file.profiles?.[profileId] ? profileId : active
  const profile: StoredProfile = { ...(file.profiles?.[target] ?? {}) }
  const next: StoredFile = { ...file }
  for (const [k, v] of Object.entries(partial)) {
    if (isProfileKey(k)) (profile as Record<string, unknown>)[k] = v
    else (next as Record<string, unknown>)[k] = v
  }
  const hasProfile = file.profiles?.[target] || PROFILE_KEYS.some((k) => k in partial)
  if (hasProfile) {
    next.profiles = { ...(file.profiles ?? {}), [target]: profile }
    next.activeProfile = active
  }
  await writeStoredFile(next)
}

async function writeStoredFile(next: StoredFile): Promise<void> {
  const dir = configDir()
  await mkdir(dir, { recursive: true })
  const path = configPath()
  await Bun.write(path, JSON.stringify(next, null, 2) + "\n")
  // The file holds an API token — restrict it to the owner.
  try {
    await chmod(path, 0o600)
  } catch {
    // Best-effort (e.g. on filesystems without POSIX perms).
  }
}

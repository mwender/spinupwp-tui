// Global data + navigation store, exposed via React context.
//
// Holds the API client, the fetched collections (servers / sites / events),
// loading + error state, and the active navigation route. A single source of
// truth keeps the splash screen, header, and views in sync, and lets any view
// trigger a refresh.

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { SpinupWPClient, ApiError, type ServerService } from "../api/client.ts"
import type { Server, Site, Event, ProviderMetadata, CreateServerPayload } from "../api/types.ts"
import { loadConfig, saveConfig, type ServerProviderRef } from "../config.ts"
import { saveJob, removeJob } from "../lib/jobs.ts"
import { APP_VERSION } from "../version.ts"
import { cachedUpdateInfo, refreshUpdateInfo, type UpdateInfo } from "../lib/appUpdate.ts"
import { resolveLocalLink, expandPath, normalizeLink, type LocalLink } from "../lib/local.ts"
import type { Stack } from "../lib/stack.ts"
import { openTerminalAt, openUrl, openSshSession } from "../lib/open.ts"
import { gitDrift, type Drift } from "../lib/gitStatus.ts"
import { probeSite } from "../lib/probe.ts"
import { resolveZone, normalizeDomain, candidateHostnames } from "../lib/dns.ts"
import { queryAuthoritative } from "../lib/dnsQuery.ts"
import { DnsCache, type CachedDns } from "../lib/dnsCache.ts"
import {
  verifyConnection as verifyProviderConnection,
  apiProviderFor,
  nameserversMatch,
  PROVIDER_CONSOLE,
  PROVIDER_REGISTRY,
  ALL_PROVIDERS,
  type Connection,
  type ConnProvider,
  type VerifyResult,
  type AccessState,
} from "../lib/providers.ts"
import { ProvidersCache, type VerifiedConn } from "../lib/providersCache.ts"
import { recordProviderFor, type DnsRecord, type RecordResult } from "../lib/dnsRecords.ts"
import { deriveSiteUser, seedVanityIndex, aRecordResolves } from "../lib/vanitySite.ts"
import type { StoredProviders } from "../config.ts"
import { fetchRebootInfo, grantSiteSshKey, revokeSiteSshKey, verifySudo, ensureSpinupKey, listPersonalKeys, keyBody, type RebootInfo } from "../lib/ssh.ts"
import { StackCache, siteSignature, type CachedProbe } from "../lib/stackCache.ts"
import { resolvePhpEolDates, refreshPhpEolDates, isPhpEol as isPhpEolWith, offeredPhpVersions as offeredPhpVersionsWith, type PhpEolDates } from "../lib/phpEol.ts"
import { planDbBackup, runDbBackup, type DbBackupProgress, type PlanResult } from "../lib/dbBackup.ts"
import { planDbSync, runDbSync, type DbSyncProgress, type SyncPlanResult } from "../lib/dbSync.ts"
import { planMediaFallback, type MediaFallbackResult } from "../lib/mediaFallback.ts"

export type Route = "dashboard" | "servers" | "stacks" | "search" | "events"

// Progress of a PHP-version upgrade, tracked in the store so it survives the
// modal being closed. `status` mirrors the SpinupWP event status
// (queued/creating/updating/… → deployed | failed); non-terminal means in-flight.
export interface PhpUpgradeProgress {
  target: string
  status: string
  error?: string
}

// SpinupWP event statuses that mean the operation has settled.
const UPGRADE_DONE = "deployed"
const UPGRADE_FAIL = "failed"
const UPGRADE_POLL_MS = 2500

export function isUpgradeInFlight(p: PhpUpgradeProgress | undefined): boolean {
  return p != null && p.status !== UPGRADE_DONE && p.status !== UPGRADE_FAIL
}

// A server-level operation (reboot or a service restart), tracked in the store
// so progress survives closing the Server-actions overlay (same model as
// PhpUpgradeProgress, keyed by server id). `label` is a short display verb.
export type ServerOpKind = "reboot" | ServerService
export interface ServerOpProgress {
  kind: ServerOpKind
  label: string
  status: string
  error?: string
}

export function isServerOpInFlight(p: ServerOpProgress | undefined): boolean {
  return p != null && p.status !== UPGRADE_DONE && p.status !== UPGRADE_FAIL
}

// Progress of a server-provisioning job (POST /servers), tracked in the store so
// it survives the New-server overlay being closed (provisioning takes ~10 min).
// `status`: queued → <event status> → done | failed. Single-slot (one create at a
// time). serverId is filled once we learn it from the settled event/refresh.
export interface NewServerJob {
  hostname: string
  status: string
  serverId?: number
  error?: string
  startedAt?: number // ms epoch when the create was fired (drives the elapsed readout)
  eventId?: number // SpinupWP event being polled — the key that lets us resume after a restart
}

// The vanity-site build: a multi-step orchestration (DNS A record → propagate →
// create site → enable HTTPS → SSH-key handoff → seed index.php) that connects a
// fresh, empty server. Steps dns/site/https are event/poll-backed (true resume);
// sshkey is a manual park; seed is an idempotent SSH push.
export type VanityStep = "dns" | "propagate" | "site" | "https" | "sshkey" | "seed" | "done" | "error"
export interface VanityJob {
  serverId: number
  serverIp: string
  hostname: string // = domain = server name
  apex: string // the zone apex the A record is written into
  siteUser: string
  publicFolder: string | null
  port: number | null // server ssh_port, captured for the seed step
  step: VanityStep
  failedStep?: VanityStep
  error?: string
  startedAt: number
  connId?: string // the DNS provider connection serving the zone
  siteId?: number // the created site (for the HTTPS call + deep links)
  sslSkipped?: boolean
  propagateTimedOut?: boolean // DNS hasn't resolved within the window → offer skip/wait
  propagateStartedAt?: number
}
export function isVanityInFlight(j: VanityJob | null | undefined): boolean {
  return j != null && j.step !== "done" && j.step !== "error"
}

// Resumable-job ids. The server create is a singleton; the per-site jobs are
// keyed by site id so several can be in flight (and resume) at once.
const NEW_SERVER_JOB_ID = "newServer"
const VANITY_JOB_ID = "vanity"
const VANITY_POLL_MS = 2500
const VANITY_PROPAGATE_TIMEOUT_MS = 120_000 // ~2 min, then offer skip/keep-waiting
const phpJobId = (siteId: number) => `phpUpgrade:${siteId}`
const dbSyncJobId = (siteId: number) => `dbSync:${siteId}`
const dbBackupJobId = (siteId: number) => `dbBackup:${siteId}`

// SSH-orchestrated jobs (no SpinupWP event to re-attach to) can't truly resume —
// their child processes died with the app. On restart we surface them as
// interrupted rather than pretend, since the local DB may be half-applied.
const INTERRUPTED_SYNC_MSG = "Interrupted by a restart — your local database may be partially imported. Re-run the sync (p)."
const INTERRUPTED_BACKUP_MSG = "Interrupted by a restart — the download didn't finish. Re-run the backup (d)."
// Server provisioning events settle with one of these (broader than PHP/site
// writes, whose terminal is "deployed"); finished_at also implies done.
const SERVER_DONE = new Set(["deployed", "completed", "provisioned", "finished", "success"])
const SERVER_FAIL = new Set(["failed", "errored", "error"])

export function isNewServerInFlight(j: NewServerJob | null | undefined): boolean {
  return j != null && j.status !== "done" && j.status !== "failed"
}

// Progress of an SSH-key grant (drop Spinup's machine key into a site user's
// authorized_keys, via sudo), keyed by site id. SSH-orchestrated and fast, so —
// unlike the event-backed writes — it isn't persisted/resumed; it just lives for
// the session so the overlay can follow it. `status`: probing → granting → done | error.
export interface KeyGrantProgress {
  status: string
  target?: string
  error?: string
}
export function isKeyGrantInFlight(p: KeyGrantProgress | undefined): boolean {
  return p != null && p.status !== "done" && p.status !== "error"
}

// A record TTL change (Phase 3), tracked in the store (same model as the other
// writes) so it survives the records overlay being closed and a Route 53 change
// can keep polling to INSYNC in the background. Keyed by the record's stable key.
// `status`: queued → pending (Route 53 propagating) → done | failed. Cloudflare
// applies synchronously, so it jumps straight to done.
export interface TtlWriteProgress {
  ttl: number
  status: string
  error?: string
  host: string // record hostname (lowercased) — lets the inventory match a write to a row
  type: string // record type (A / AAAA / CNAME …)
}
const TTL_DONE = "done"
const TTL_FAIL = "failed"
const TTL_POLL_MS = 3000

export function isTtlWriteInFlight(p: TtlWriteProgress | undefined): boolean {
  return p != null && p.status !== TTL_DONE && p.status !== TTL_FAIL
}

// A resolved website-hosting record for one hostname (apex / www / additional
// domain), read cred-free from the zone's authoritative NS for the DNS inventory.
// `type === "none"` means the hostname has no record (e.g. www isn't configured).
export interface HostRecord {
  host: string // the hostname (lowercased)
  apex: string // its zone apex
  type: string // A | AAAA | CNAME | none
  ttl: number | null // configured TTL (from the authoritative answer)
  value: string // record value (IP or CNAME target)
  pointsHere: boolean // resolves (following CNAMEs) to this server's IP
  checkedAt: number
}

export interface DataState {
  servers: Server[]
  sites: Site[]
  events: Event[]
  loading: boolean
  // Set once the very first load (servers + sites) has completed — drives the splash.
  ready: boolean
  error: string | null
  lastUpdated: Date | null
  // Latest released version vs. the running one (null until/unless we learn it).
  updateInfo: UpdateInfo | null
}

interface StoreValue extends DataState {
  client: SpinupWPClient
  route: Route
  setRoute: (r: Route) => void
  refresh: () => Promise<void>
  // When true, global keyboard shortcuts are suppressed (e.g. while typing in a search box).
  inputMode: boolean
  setInputMode: (v: boolean) => void
  // When true, a modal overlay (e.g. help) is open and views should ignore navigation keys.
  overlayOpen: boolean
  setOverlayOpen: (v: boolean) => void
  // The server whose live health view is open, or null. Set by the Browser.
  healthServer: Server | null
  setHealthServer: (s: Server | null) => void
  // The site whose PHP-upgrade overlay is open, or null. Set by site views.
  phpUpgradeSite: Site | null
  setPhpUpgradeSite: (s: Site | null) => void
  // In-flight (and just-failed) PHP upgrades, keyed by site id. Tracked in the
  // store — not the overlay — so progress survives closing the modal; site rows
  // and detail panels read this to show a spinner/marker.
  phpUpgrades: Map<number, PhpUpgradeProgress>
  // Fire a PHP upgrade and poll its event to completion in the background.
  startPhpUpgrade: (site: Site, version: string) => void
  // Drop a terminal (deployed/failed) entry — e.g. when the modal is dismissed.
  clearPhpUpgrade: (siteId: number) => void
  // The server whose actions overlay (reboot / service restart) is open, or null.
  serverActionsServer: Server | null
  setServerActionsServer: (s: Server | null) => void
  // In-flight (and just-failed) server operations, keyed by server id.
  serverOps: Map<number, ServerOpProgress>
  // Fire a server op (reboot or service restart) and poll its event in the background.
  startServerOp: (server: Server, kind: ServerOpKind, label: string) => void
  clearServerOp: (serverId: number) => void
  // Whether the "create a server" overlay is open. Separate from the source so the
  // flow can run with no seed (general "from scratch" create, and the empty-fleet
  // case where there's no server to select).
  newServerOpen: boolean
  setNewServerOpen: (v: boolean) => void
  // The source server whose specs seed the form (match-source default), or null
  // for a from-scratch create.
  newServerSource: Server | null
  setNewServerSource: (s: Server | null) => void
  // The single in-flight (or just-settled) provisioning job, tracked in the store
  // so it survives closing the overlay. Null when no create is pending/recent.
  newServerJob: NewServerJob | null
  // Fire POST /servers and poll its event to completion in the background.
  startNewServer: (payload: CreateServerPayload, hostname: string) => void
  clearNewServer: () => void
  // Vanity-site build (connect a fresh, empty server). `vanityServer` opens the
  // overlay; `vanityJob` is the resumable multi-step progress.
  vanityServer: Server | null
  setVanityServer: (s: Server | null) => void
  vanityJob: VanityJob | null
  startVanity: (server: Server, opts: { siteUser: string; skipSsl?: boolean }) => void
  vanitySshKeyDone: () => void // user confirms the SSH key is on the server → seed
  vanitySkipSsl: () => void // from the propagation-timeout prompt: create site, skip HTTPS
  vanityKeepWaiting: () => void // from the prompt: reset the propagation window
  vanityRetry: () => void // re-enter the failed step
  clearVanity: () => void
  // Provider size/region catalog (with pricing), cached per provider key for the
  // session. loadProviderMetadata fetches lazily on demand.
  providerMetadata: Map<string, ProviderMetadata>
  providerMetadataLoading: Set<string>
  providerMetadataError: Map<string, string>
  loadProviderMetadata: (providerKey: string) => void
  // SpinupWP server-provider connections (provider key → {id}), from config.
  serverProviders: Record<string, ServerProviderRef>
  // Persist a provider id supplied in-app (writes config.json).
  saveServerProviderId: (providerKey: string, id: number) => void
  // Reboot "why" — SSH-probed Ubuntu reboot-required detail, keyed by server id.
  rebootInfo: Map<number, RebootInfo>
  rebootInfoLoading: Set<number>
  rebootInfoErrors: Map<number, string>
  loadRebootInfo: (server: Server) => void
  // Grant-SSH-key overlay (privileged write-over-SSH): the site whose machine-key
  // grant overlay is open, or null. Set by site views.
  grantKeySite: Site | null
  setGrantKeySite: (s: Site | null) => void
  // In-flight (and just-settled) key grants, keyed by site id. Tracked in the
  // store so the grant survives closing the modal (mirrors the other writes).
  keyGrants: Map<number, KeyGrantProgress>
  // Grant the given public keys (machine and/or personal) to one or many sites'
  // authorized_keys via the server's sudo user (all sites must share a server).
  // Reads the sudo user + (in-memory) password from the store; per-site progress
  // lands in keyGrants. The overlay resolves which key lines and which sites.
  startGrantKey: (sites: Site[], pubkeys: string[]) => void
  // Remove the given keys from one or many sites' authorized_keys (reverse of grant).
  startRevokeKey: (sites: Site[], pubkeys: string[]) => void
  // Grant the user's remembered keys to the given sites (resolves saved selection
  // to key lines). Used by auto-grant flows like the vanity build.
  startGrantRemembered: (sites: Site[]) => void
  // The key bodies the user last chose to grant (pre-selected next time), persisted.
  preferredGrantKeys: string[]
  setPreferredGrantKeys: (ids: string[]) => void
  // Whether Spinup has granted any key on a site (drives the row badge), and the
  // recorded key bodies. forgetGrantedKeys is used by revoke.
  siteHasGrantedKey: (siteId: number) => boolean
  // Granted keys on a site split into personal (yours) vs machine (spinup-tui).
  grantedKeyKinds: (siteId: number) => { personal: number; machine: number }
  grantedKeys: Map<number, Set<string>>
  forgetGrantedKeys: (siteId: number, bodies: string[]) => void
  clearGrantKey: (siteId: number) => void
  // Per-server sudo user (persisted, username only) for privileged writes.
  sudoUserFor: (serverId: number) => string | undefined
  // Sudo "connection" on a server: validate the sudo user + password against the
  // live server, then hold them for the session so every privileged action on that
  // server just works (the explicit ● connected model). The password is in-memory only.
  sudoConnectServer: Server | null
  setSudoConnectServer: (s: Server | null) => void
  isSudoConnected: (serverId: number) => boolean
  connectSudo: (server: Server, user: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>
  disconnectSudo: (serverId: number) => void
  // The site whose local-link overlay is open, or null. Set by site views.
  localLinkSite: Site | null
  setLocalLinkSite: (s: Site | null) => void
  // Local working-copy links, keyed by site id (hydrated from config; persisted
  // on every change). Phase 1: manual link/unlink + view, no mutation.
  localLinks: Map<number, LocalLink>
  // Create or update a site's local link and persist it to the config file.
  linkSite: (siteId: number, link: LocalLink) => void
  // Remove a site's local link and persist the removal.
  unlinkSite: (siteId: number) => void
  // Configured scan roots for auto-discovery (hydrated from config, persisted on
  // change). The discovery overlay scans these for local working copies.
  localRoots: string[]
  addLocalRoot: (dir: string) => void
  // Whether the local-copy discovery overlay is open.
  discoverOpen: boolean
  setDiscoverOpen: (v: boolean) => void
  // Whether the "needs a local copy" (forgotten) report overlay is open, and an
  // optional stack filter (set from the selected Stacks group when opened).
  forgottenOpen: boolean
  setForgottenOpen: (v: boolean) => void
  forgottenStack: Stack | null
  setForgottenStack: (s: Stack | null) => void
  // When true, closing the link overlay reopens the forgotten report (set only
  // when the link overlay was opened from that report, so Esc behaves normally
  // everywhere else).
  linkReturnToForgotten: boolean
  setLinkReturnToForgotten: (v: boolean) => void
  // Open the local working copy in a terminal / the local URL in a browser.
  // Centralized so every surface (overlay, Stacks, Browser) behaves identically;
  // each returns a short status message for the caller to flash.
  openLocalTerminal: (siteId: number) => string
  openLocalUrl: (siteId: number) => string
  // Open a terminal and SSH into the site (site_user@server_ip). Returns a flash.
  sshSite: (siteId: number) => string
  // The site whose DB-backup overlay is open, or null. Set by site views.
  dbBackupSite: Site | null
  setDbBackupSite: (s: Site | null) => void
  // In-flight (and just-settled) DB-backup downloads, keyed by site id. Tracked in
  // the store — not the overlay — so the download survives closing the modal.
  dbBackups: Map<number, DbBackupProgress>
  // Resolve a site's backup plan (SSH target, remote docroot, local destination)
  // or a reason it can't run — used by the overlay's confirm screen.
  planDbBackupFor: (site: Site) => PlanResult
  // Export the production DB and download it to the linked project's sql/ dir.
  startDbBackup: (site: Site) => void
  clearDbBackup: (siteId: number) => void
  // The site whose DB-sync overlay is open, or null. Set by site views.
  dbSyncSite: Site | null
  setDbSyncSite: (s: Site | null) => void
  // In-flight (and just-settled) DB syncs, keyed by site id. Tracked in the store
  // so the (longer, destructive-on-local) sync survives closing the modal.
  dbSyncs: Map<number, DbSyncProgress>
  // Resolve a site's sync plan (remote + local detection) or a reason it can't run.
  planDbSyncFor: (site: Site) => SyncPlanResult
  // Pull production into the local copy: backup local → export/download prod →
  // import → search-replace URLs → run post-import hook. Destructive on LOCAL.
  startDbSync: (site: Site) => void
  clearDbSync: (siteId: number) => void

  // Production media fallback overlay (mu-plugin in the linked local copy). State
  // is the plugin file's presence, resolved fresh by planMediaFallbackFor.
  mediaFallbackSite: Site | null
  setMediaFallbackSite: (s: Site | null) => void
  planMediaFallbackFor: (site: Site) => MediaFallbackResult
  // Local git drift for linked sites, keyed by site id (null = not a git repo,
  // undefined = not yet computed). Computed lazily + cached; cleared on refresh.
  drift: Map<number, Drift | null>
  ensureDrift: (siteId: number, linkPath: string) => void
  // Optional SSH user override for the health view (from env/config).
  sshUser: string | null
  // Opt-in for the destructive production→local DB sync (`p`); default off.
  localSync: boolean
  // SpinupWP account slug (from env/config) for building web deep links.
  accountSlug: string | null
  sitesForServer: (serverId: number) => Site[]
  serverById: (id: number | null | undefined) => Server | undefined
  // Tier-2 stack probes (on-demand SSH), hydrated from disk at startup.
  probes: Map<number, CachedProbe> // by site id
  probingIds: Set<number> // sites with an in-flight probe
  probeErrors: Map<number, string> // last error per site id
  // Probe a single site over SSH (fire-and-forget); write-through to the cache.
  runProbe: (site: Site) => void
  // Probe many sites with a bounded concurrency pool (skips in-flight sites).
  runProbeMany: (sites: Site[]) => void
  // Whether a cached probe for this site is stale (site shape changed since).
  isProbeStale: (site: Site) => boolean
  // DNS zone-host lookups (read-only). Hydrated from disk at startup; resolved
  // lazily on demand (never auto-fired on selection — network cost).
  dnsZones: Map<string, CachedDns> // by normalized domain (www-stripped, lowercased)
  dnsResolving: Set<string> // normalized domains with an in-flight lookup
  // Resolve every domain of a site / of all sites on a server (bounded conc).
  lookupSiteDns: (site: Site, force?: boolean) => void
  lookupServerDns: (serverId: number, force?: boolean) => void
  // The cached zone-host for a domain (undefined = never looked up).
  zoneForDomain: (domain: string) => CachedDns | undefined
  isDnsResolving: (domain: string) => boolean
  // Website-hosting records (apex/www/additional + TTLs), keyed by hostname.
  // Read cred-free from each zone's authoritative NS; resolved lazily once the
  // zone's NS are known. The migration-focused inventory reads these.
  hostingRecords: Map<string, HostRecord>
  // Resolve every site's hosting hostnames on a server (needs the zone NS first).
  resolveServerHosting: (server: Server, force?: boolean) => void
  hostingFor: (host: string) => HostRecord | undefined
  isHostingResolving: (host: string) => boolean
  // The server whose DNS-inventory overlay is open, or null. Set by site views.
  // `focusSiteId` (optional) scopes the overlay to a single site (opened via `n`);
  // null shows every site on the server (opened via `N`).
  dnsInventoryServer: Server | null
  dnsInventoryFocusSiteId: number | null
  setDnsInventoryServer: (s: Server | null, focusSiteId?: number | null) => void
  setDnsInventoryFocusSiteId: (id: number | null) => void
  // DNS provider connections (Phase 2), keyed by provider — each is a credential
  // ("account"). The overlay lists + manages them. `providerZones` holds each
  // connection's last verified zone set (hydrated from disk). Secrets persist to
  // config (chmod 600).
  connections: Record<ConnProvider, Connection[]>
  connectionsFor: (provider: ConnProvider) => Connection[]
  connectionCount: number // total across all providers
  providerZones: Map<string, VerifiedConn> // by connection id
  // Add a connection: verify FIRST, persist + cache only on success; returns the
  // verify result so the overlay can show zones or the error.
  addConnection: (provider: ConnProvider, label: string, creds: Record<string, string>) => Promise<VerifyResult>
  removeConnection: (id: string) => void // stored connections only (not env)
  verifyConnectionById: (id: string) => void // re-verify + refresh cache
  // Access state for a zone, from its live host, the live authoritative NS, and
  // the verified zones we can reach. Provider-scoped + NS-aware (see store impl).
  accessForZone: (apex: string, hostKey: string, liveNs: string[]) => AccessState
  // The connection (account) label that owns/serves a zone, or "" if none.
  accountForZone: (apex: string, hostKey: string, liveNs: string[]) => string
  // The connection (with creds) that serves a zone, or null — drives record editing.
  connForZone: (apex: string, hostKey: string, liveNs: string[]) => Connection | null
  // The zone whose provider-connect overlay is open (apex + its host key), or null.
  connectZoneTarget: { apex: string; hostKey: string } | null
  setConnectZoneTarget: (t: { apex: string; hostKey: string } | null) => void
  // The zone whose DNS-records overlay is open (Phase 3: view records + edit TTL),
  // with the connection id we'll authenticate the record calls with. `record` is the
  // single hosting record to edit (migration lens — never a whole zone). null = closed.
  dnsRecordsTarget: { apex: string; hostKey: string; connId: string; record: { name: string; type: string } } | null
  setDnsRecordsTarget: (t: { apex: string; hostKey: string; connId: string; record: { name: string; type: string } } | null) => void
  // In-flight (and just-settled) record TTL changes, keyed by the record key.
  // Tracked in the store so a Route 53 change keeps polling after the overlay closes.
  ttlWrites: Map<string, TtlWriteProgress>
  // Read ONE hosting record via the serving connection (scoped; on demand).
  getZoneRecord: (connId: string, apex: string, name: string, type: string) => Promise<RecordResult>
  // The latest TTL write for a hostname+type (drives the inventory's updating status).
  ttlWriteForHost: (host: string, type: string) => TtlWriteProgress | undefined
  // Change a record's TTL via the host's API and follow it to completion.
  startTtlChange: (connId: string, zoneId: string, record: DnsRecord, ttl: number) => void
  clearTtlWrite: (key: string) => void
  // Whether a PHP version is past end-of-life (real dates vs today, refreshed).
  isPhpEol: (version: string | null | undefined) => boolean
  // PHP versions to offer in the upgrade picker (dynamic; current always included).
  offeredPhpVersions: (current?: string | null) => string[]
}

const StoreContext = createContext<StoreValue | null>(null)

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error("useStore must be used within <StoreProvider>")
  return ctx
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const cfgRef = useRef(loadConfig())
  const clientRef = useRef<SpinupWPClient | null>(null)
  if (!clientRef.current) {
    clientRef.current = new SpinupWPClient(cfgRef.current)
  }
  const client = clientRef.current

  const [servers, setServers] = useState<Server[]>([])
  const [sites, setSites] = useState<Site[]>([])
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  // Update check: show any cached result immediately, then refresh once per launch
  // (disk-cached, 6h TTL — see appUpdate.ts).
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(() => cachedUpdateInfo(APP_VERSION))
  useEffect(() => {
    void refreshUpdateInfo(APP_VERSION).then((info) => {
      if (info) setUpdateInfo(info)
    })
  }, [])
  const [route, setRoute] = useState<Route>("dashboard")
  const [inputMode, setInputMode] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [healthServer, setHealthServer] = useState<Server | null>(null)
  const [phpUpgradeSite, setPhpUpgradeSite] = useState<Site | null>(null)
  const [phpUpgrades, setPhpUpgrades] = useState<Map<number, PhpUpgradeProgress>>(new Map())
  const [serverActionsServer, setServerActionsServer] = useState<Server | null>(null)
  const [serverOps, setServerOps] = useState<Map<number, ServerOpProgress>>(new Map())
  const [newServerOpen, setNewServerOpen] = useState(false)
  const [newServerSource, setNewServerSource] = useState<Server | null>(null)
  const [newServerJob, setNewServerJob] = useState<NewServerJob | null>(null)
  // Vanity-site build. `vanityServer` drives the overlay (the server we're connecting);
  // `vanityJob` is the resumable progress that outlives the overlay.
  const [vanityServer, setVanityServer] = useState<Server | null>(null)
  const [vanityJob, setVanityJob] = useState<VanityJob | null>(null)
  const [providerMetadata, setProviderMetadata] = useState<Map<string, ProviderMetadata>>(new Map())
  const [providerMetadataLoading, setProviderMetadataLoading] = useState<Set<string>>(new Set())
  const [providerMetadataError, setProviderMetadataError] = useState<Map<string, string>>(new Map())
  const [serverProviders, setServerProviders] = useState<Record<string, ServerProviderRef>>(() => cfgRef.current.serverProviders)
  const [localLinkSite, setLocalLinkSite] = useState<Site | null>(null)
  // Privileged SSH-key grant. The overlay target + per-site progress; the sudo
  // user is persisted (state, hydrated from config) while the sudo password is
  // kept in a ref (in-memory only — never rendered, never written to disk).
  const [grantKeySite, setGrantKeySite] = useState<Site | null>(null)
  const [keyGrants, setKeyGrants] = useState<Map<number, KeyGrantProgress>>(new Map())
  const [sudoUsers, setSudoUsers] = useState<Map<number, string>>(
    () => new Map(Object.entries(cfgRef.current.sudoUsers).map(([id, v]) => [Number(id), v.user])),
  )
  const sudoPwRef = useRef<Map<number, string>>(new Map())
  const [preferredGrantKeys, setPreferredGrantKeysState] = useState<string[]>(() => [...cfgRef.current.preferredGrantKeys])
  // Keys Spinup has granted, by site id → set of key bodies. Drives the row badge.
  const [grantedKeys, setGrantedKeys] = useState<Map<number, Set<string>>>(
    () => new Map(Object.entries(cfgRef.current.grantedKeys).map(([id, bodies]) => [Number(id), new Set(bodies)])),
  )
  // The spinup-tui machine key's body (base64), resolved once — lets us classify a
  // granted key as the MACHINE key vs one of the user's PERSONAL keys.
  const [machineKeyBody, setMachineKeyBody] = useState<string | null>(null)
  useEffect(() => {
    void ensureSpinupKey()
      .then((k) => setMachineKeyBody(keyBody(k.pub)))
      .catch(() => {})
  }, [])
  // Servers with sudo "connected" this session (validated user + held password). The
  // password lives in sudoPwRef (in-memory); this set just tracks which servers
  // are connected so the UI can show ● and privileged actions can gate on it.
  const [sudoConnected, setSudoConnected] = useState<Set<number>>(new Set())
  const [sudoConnectServer, setSudoConnectServer] = useState<Server | null>(null)
  const [dbBackupSite, setDbBackupSite] = useState<Site | null>(null)
  const [dbBackups, setDbBackups] = useState<Map<number, DbBackupProgress>>(new Map())
  const [dbSyncSite, setDbSyncSite] = useState<Site | null>(null)
  const [dbSyncs, setDbSyncs] = useState<Map<number, DbSyncProgress>>(new Map())
  const [mediaFallbackSite, setMediaFallbackSite] = useState<Site | null>(null)
  const [localRoots, setLocalRoots] = useState<string[]>(() => [...cfgRef.current.localRoots])
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [forgottenOpen, setForgottenOpen] = useState(false)
  const [forgottenStack, setForgottenStack] = useState<Stack | null>(null)
  const [linkReturnToForgotten, setLinkReturnToForgotten] = useState(false)
  const [drift, setDrift] = useState<Map<number, Drift | null>>(new Map())
  // Tracks which site ids have had a drift check requested (so we compute once
  // per site per session); a ref keeps ensureDrift stable across renders.
  const driftRequested = useRef<Set<number>>(new Set())
  // Hydrate local links from the stored config (JSON keys are strings → number).
  const [localLinks, setLocalLinks] = useState<Map<number, LocalLink>>(
    () => new Map(Object.entries(cfgRef.current.localSites).map(([id, link]) => [Number(id), normalizeLink(link)])),
  )
  const [rebootInfo, setRebootInfo] = useState<Map<number, RebootInfo>>(new Map())
  const [rebootInfoLoading, setRebootInfoLoading] = useState<Set<number>>(new Set())
  const [rebootInfoErrors, setRebootInfoErrors] = useState<Map<number, string>>(new Map())

  // Tier-2 stack-probe cache: hydrate from disk once (read-only at startup; no
  // SSH). Probes run lazily on demand and write through to disk.
  const cacheRef = useRef<StackCache | null>(null)
  if (!cacheRef.current) {
    cacheRef.current = new StackCache()
    cacheRef.current.load()
  }
  const [probes, setProbes] = useState<Map<number, CachedProbe>>(() => cacheRef.current!.snapshot())
  const [probingIds, setProbingIds] = useState<Set<number>>(new Set())
  const [probeErrors, setProbeErrors] = useState<Map<number, string>>(new Map())

  // DNS zone-host cache: hydrate from disk once (no network at startup); lookups
  // run lazily on demand and write through to disk. `dnsInFlight` is a ref so the
  // lookup actions can dedupe concurrent requests without re-rendering.
  const dnsCacheRef = useRef<DnsCache | null>(null)
  if (!dnsCacheRef.current) {
    dnsCacheRef.current = new DnsCache()
    dnsCacheRef.current.load()
  }
  const dnsInFlight = useRef<Set<string>>(new Set())
  const [dnsZones, setDnsZones] = useState<Map<string, CachedDns>>(() => dnsCacheRef.current!.snapshot())
  const [dnsResolving, setDnsResolving] = useState<Set<string>>(new Set())
  const [dnsInventoryServer, setDnsInventoryServerState] = useState<Server | null>(null)
  const [dnsInventoryFocusSiteId, setDnsInventoryFocusSiteId] = useState<number | null>(null)
  const setDnsInventoryServer = useCallback((s: Server | null, focusSiteId: number | null = null) => {
    setDnsInventoryServerState(s)
    setDnsInventoryFocusSiteId(focusSiteId)
  }, [])

  // Website-hosting record lookups (Phase 3 inventory). In-memory for the session;
  // resolved on demand once the hostname's zone NS are known. `hostingInFlight`
  // dedupes concurrent queries without re-rendering.
  const hostingInFlight = useRef<Set<string>>(new Set())
  const [hostingRecords, setHostingRecords] = useState<Map<string, HostRecord>>(new Map())
  const [hostingResolving, setHostingResolving] = useState<Set<string>>(new Set())

  // DNS provider connections (Phase 2). Connections hydrate from config (stored +
  // env); their verified zone sets hydrate from disk and re-verify on demand.
  const providersCacheRef = useRef<ProvidersCache | null>(null)
  if (!providersCacheRef.current) {
    providersCacheRef.current = new ProvidersCache()
    providersCacheRef.current.load()
  }
  const [connections, setConnections] = useState<Record<ConnProvider, Connection[]>>(() => cfgRef.current.providerConnections)
  const [providerZones, setProviderZones] = useState<Map<string, VerifiedConn>>(() => providersCacheRef.current!.snapshot())
  const [connectZoneTarget, setConnectZoneTarget] = useState<{ apex: string; hostKey: string } | null>(null)
  const [dnsRecordsTarget, setDnsRecordsTarget] = useState<{ apex: string; hostKey: string; connId: string; record: { name: string; type: string } } | null>(null)
  const [ttlWrites, setTtlWrites] = useState<Map<string, TtlWriteProgress>>(new Map())

  // PHP EOL dates: embedded defaults overlaid with the last cached fetch; a
  // background refresh (endoflife.date) updates them when the cache is stale.
  const [phpEolDates, setPhpEolDates] = useState<PhpEolDates>(() => resolvePhpEolDates())
  useEffect(() => {
    void refreshPhpEolDates().then((updated) => {
      if (updated) setPhpEolDates(updated)
    })
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    // Drift can go stale once the user commits/pushes in their terminal — clear
    // the cache on refresh so it recomputes next time a linked site is shown.
    driftRequested.current.clear()
    setDrift(new Map())
    try {
      // Servers + sites first (the core data); events are best-effort.
      const [srv, ste] = await Promise.all([client.listServers(), client.listSites()])
      setServers(srv)
      setSites(ste)
      setLastUpdated(new Date())
      setReady(true)
      try {
        setEvents(await client.listEvents(2))
      } catch {
        // Events are non-critical; ignore failures so the app still loads.
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err as Error).message
      setError(msg)
      setReady(true) // allow the app to render the error state rather than hang on splash
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const sitesForServer = useCallback(
    (serverId: number) => sites.filter((s) => s.server_id === serverId),
    [sites],
  )
  const serverById = useCallback(
    (id: number | null | undefined) => (id == null ? undefined : servers.find((s) => s.id === id)),
    [servers],
  )

  // Probe one site and reconcile state + cache. Concurrency-safe (all state
  // updates are functional), so the batch runner can pool several at once.
  const probeOne = useCallback(
    async (site: Site) => {
      const cache = cacheRef.current!
      setProbingIds((prev) => new Set(prev).add(site.id))
      setProbeErrors((prev) => {
        if (!prev.has(site.id)) return prev
        const next = new Map(prev)
        next.delete(site.id)
        return next
      })
      const server = servers.find((s) => s.id === site.server_id)
      const outcome = await probeSite(site, server, cfgRef.current.sshUser)
      if (outcome.ok) {
        await cache.set(site.id, outcome.result, siteSignature(site))
        setProbes(cache.snapshot())
      } else {
        setProbeErrors((prev) => new Map(prev).set(site.id, outcome.error))
      }
      setProbingIds((prev) => {
        const next = new Set(prev)
        next.delete(site.id)
        return next
      })
    },
    [servers],
  )

  const runProbe = useCallback(
    (site: Site) => {
      if (probingIds.has(site.id)) return // already in flight
      void probeOne(site)
    },
    [probeOne, probingIds],
  )

  // Probe many sites with a bounded SSH concurrency pool. Skips sites already
  // in flight; callers decide whether to pass un-probed/stale sites only.
  const runProbeMany = useCallback(
    (sitesToProbe: Site[]) => {
      const queue = sitesToProbe.filter((s) => !probingIds.has(s.id))
      if (queue.length === 0) return
      const CONCURRENCY = 5
      let cursor = 0
      const worker = async () => {
        while (cursor < queue.length) {
          const site = queue[cursor++]
          await probeOne(site)
        }
      }
      for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) void worker()
    },
    [probeOne, probingIds],
  )

  const isProbeStale = useCallback((site: Site) => cacheRef.current!.isStale(site.id, siteSignature(site)), [])

  const isPhpEol = useCallback((version: string | null | undefined) => isPhpEolWith(version, phpEolDates), [phpEolDates])
  const offeredPhpVersions = useCallback(
    (current?: string | null) => offeredPhpVersionsWith(phpEolDates, current),
    [phpEolDates],
  )

  const setUpgrade = (siteId: number, progress: PhpUpgradeProgress) =>
    setPhpUpgrades((prev) => new Map(prev).set(siteId, progress))

  const clearPhpUpgrade = useCallback(
    (siteId: number) => {
      void removeJob(phpJobId(siteId))
      setPhpUpgrades((prev) => {
        if (!prev.has(siteId)) return prev
        const next = new Map(prev)
        next.delete(siteId)
        return next
      })
    },
    [],
  )

  // Poll a PHP-upgrade event to completion, mirroring status into the per-site
  // marker and clearing the persisted job once settled. Shared by a fresh upgrade
  // and resume-on-startup (event-backed, so it reconnects cleanly).
  const trackPhpUpgradeEvent = useCallback(
    (siteId: number, version: string, eventId: number) => {
      const poll = async () => {
        try {
          const ev = await client.getEvent(eventId)
          if (ev.status === UPGRADE_DONE) {
            await refresh() // pull the new php_version into the store…
            clearPhpUpgrade(siteId) // …then the row reflects truth, no marker needed
          } else if (ev.status === UPGRADE_FAIL) {
            setUpgrade(siteId, { target: version, status: UPGRADE_FAIL, error: ev.output?.trim() || "The upgrade event failed on SpinupWP." })
            void removeJob(phpJobId(siteId))
          } else {
            setUpgrade(siteId, { target: version, status: ev.status })
            setTimeout(() => void poll(), UPGRADE_POLL_MS)
          }
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : (err as Error).message
          setUpgrade(siteId, { target: version, status: UPGRADE_FAIL, error: msg })
          void removeJob(phpJobId(siteId))
        }
      }
      setTimeout(() => void poll(), UPGRADE_POLL_MS)
    },
    [client, refresh, clearPhpUpgrade],
  )

  const startPhpUpgrade = useCallback(
    (site: Site, version: string) => {
      // Ignore a duplicate request while one is already running for this site.
      const existing = phpUpgrades.get(site.id)
      if (existing && existing.status !== UPGRADE_DONE && existing.status !== UPGRADE_FAIL) return

      const startedAt = Date.now()
      const run = async () => {
        setUpgrade(site.id, { target: version, status: "queued" })
        let eventId: number
        try {
          const res = await client.upgradeSitePhp(site.id, version)
          eventId = res.event_id
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : (err as Error).message
          setUpgrade(site.id, { target: version, status: UPGRADE_FAIL, error: msg })
          return
        }
        // Persist so a restart resumes tracking this site's upgrade, then poll.
        setUpgrade(site.id, { target: version, status: "running" })
        void saveJob({ id: phpJobId(site.id), kind: "phpUpgrade", status: "running", startedAt, eventId, inputs: { siteId: site.id, version, domain: site.domain } })
        trackPhpUpgradeEvent(site.id, version, eventId)
      }
      void run()
    },
    [client, trackPhpUpgradeEvent, phpUpgrades],
  )

  // ---- Server operations (reboot / service restart) ---------------------

  const setOp = (serverId: number, progress: ServerOpProgress) =>
    setServerOps((prev) => new Map(prev).set(serverId, progress))

  const clearServerOp = useCallback(
    (serverId: number) =>
      setServerOps((prev) => {
        if (!prev.has(serverId)) return prev
        const next = new Map(prev)
        next.delete(serverId)
        return next
      }),
    [],
  )

  const startServerOp = useCallback(
    (server: Server, kind: ServerOpKind, label: string) => {
      const existing = serverOps.get(server.id)
      if (existing && existing.status !== UPGRADE_DONE && existing.status !== UPGRADE_FAIL) return

      const run = async () => {
        setOp(server.id, { kind, label, status: "queued" })
        let eventId: number
        try {
          const res = kind === "reboot" ? await client.rebootServer(server.id) : await client.restartService(server.id, kind)
          eventId = res.event_id
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : (err as Error).message
          setOp(server.id, { kind, label, status: UPGRADE_FAIL, error: msg })
          return
        }

        const poll = async () => {
          try {
            const ev = await client.getEvent(eventId)
            if (ev.status === UPGRADE_DONE) {
              await refresh() // reboot clears reboot_required; status may flip too
              clearServerOp(server.id)
            } else if (ev.status === UPGRADE_FAIL) {
              setOp(server.id, { kind, label, status: UPGRADE_FAIL, error: ev.output?.trim() || "The operation failed on SpinupWP." })
            } else {
              setOp(server.id, { kind, label, status: ev.status })
              setTimeout(() => void poll(), UPGRADE_POLL_MS)
            }
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : (err as Error).message
            setOp(server.id, { kind, label, status: UPGRADE_FAIL, error: msg })
          }
        }
        setTimeout(() => void poll(), UPGRADE_POLL_MS)
      }
      void run()
    },
    [client, refresh, clearServerOp, serverOps],
  )

  // ---- Create a server (POST /servers) ----------------------------------

  // Fetch a provider's size/region catalog once per session (lazy, cached).
  const loadProviderMetadata = useCallback(
    (providerKey: string) => {
      // Skip if already cached or a fetch is in flight for this provider.
      if (providerMetadata.has(providerKey)) return
      if (providerMetadataLoading.has(providerKey)) return
      setProviderMetadataLoading((prev) => new Set(prev).add(providerKey))
      setProviderMetadataError((prev) => {
        if (!prev.has(providerKey)) return prev
        const next = new Map(prev)
        next.delete(providerKey)
        return next
      })
      void (async () => {
        try {
          const md = await client.providerMetadata(providerKey)
          setProviderMetadata((prev) => new Map(prev).set(providerKey, md))
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : (err as Error).message
          setProviderMetadataError((prev) => new Map(prev).set(providerKey, msg))
        } finally {
          setProviderMetadataLoading((prev) => {
            const next = new Set(prev)
            next.delete(providerKey)
            return next
          })
        }
      })()
    },
    [client, providerMetadata, providerMetadataLoading],
  )

  const clearNewServer = useCallback(() => {
    setNewServerJob(null)
    void removeJob(NEW_SERVER_JOB_ID)
  }, [])

  // Persist a SpinupWP server-provider id (the API can't list these, so the user
  // supplies it once; saved to config.json like accountSlug). cfgRef is the source
  // of truth so this never closes over a stale map.
  const saveServerProviderId = useCallback((providerKey: string, id: number) => {
    const prev = cfgRef.current.serverProviders
    const next = { ...prev, [providerKey]: { ...(prev[providerKey] ?? {}), id } }
    cfgRef.current.serverProviders = next
    setServerProviders(next)
    void saveConfig({ serverProviders: next })
  }, [])

  // Poll a server-create event to completion, mirroring its status into the job
  // and clearing the persisted entry once it settles. Shared by a fresh create
  // and by resume-on-startup, so the job survives a quit/relaunch.
  const trackServerEvent = useCallback(
    (eventId: number, hostname: string, startedAt: number) => {
      const poll = async () => {
        try {
          const ev = await client.getEvent(eventId)
          if (SERVER_FAIL.has(ev.status)) {
            setNewServerJob({ hostname, status: "failed", error: ev.output?.trim() || "The server build failed on SpinupWP.", startedAt, eventId })
            void removeJob(NEW_SERVER_JOB_ID)
          } else if (SERVER_DONE.has(ev.status) || ev.finished_at) {
            await refresh() // pull the new server into the list
            setNewServerJob({ hostname, status: "done", serverId: ev.server_id ?? undefined, startedAt, eventId })
            void removeJob(NEW_SERVER_JOB_ID)
          } else {
            setNewServerJob({ hostname, status: ev.status, startedAt, eventId })
            setTimeout(() => void poll(), UPGRADE_POLL_MS)
          }
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : (err as Error).message
          setNewServerJob({ hostname, status: "failed", error: msg, startedAt, eventId })
          void removeJob(NEW_SERVER_JOB_ID)
        }
      }
      setTimeout(() => void poll(), UPGRADE_POLL_MS)
    },
    [client, refresh],
  )

  const startNewServer = useCallback(
    (payload: CreateServerPayload, hostname: string) => {
      // One create at a time; ignore a duplicate fire while one is in flight.
      if (newServerJob && newServerJob.status !== "done" && newServerJob.status !== "failed") return

      const startedAt = Date.now()
      const run = async () => {
        setNewServerJob({ hostname, status: "queued", startedAt })
        let eventId: number
        try {
          const res = await client.createServer(payload)
          eventId = res.event_id
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : (err as Error).message
          setNewServerJob({ hostname, status: "failed", error: msg, startedAt })
          return
        }
        // Event id known → persist so a restart can resume tracking, then poll.
        setNewServerJob({ hostname, status: "running", startedAt, eventId })
        void saveJob({ id: NEW_SERVER_JOB_ID, kind: "newServer", status: "running", startedAt, eventId, inputs: { hostname } })
        trackServerEvent(eventId, hostname, startedAt)
      }
      void run()
    },
    [client, newServerJob, trackServerEvent],
  )

  // SSH-probe a server's Ubuntu reboot-required detail (the "why"). On-demand,
  // cached in memory for the session (read-only; reuses the health SSH path).
  const loadRebootInfo = useCallback(
    (server: Server) => {
      if (rebootInfoLoading.has(server.id)) return
      const run = async () => {
        setRebootInfoLoading((prev) => new Set(prev).add(server.id))
        setRebootInfoErrors((prev) => {
          if (!prev.has(server.id)) return prev
          const next = new Map(prev)
          next.delete(server.id)
          return next
        })
        const res = await fetchRebootInfo(server, sites, cfgRef.current.sshUser)
        if (res.ok) setRebootInfo((prev) => new Map(prev).set(server.id, res.info))
        else setRebootInfoErrors((prev) => new Map(prev).set(server.id, res.error))
        setRebootInfoLoading((prev) => {
          const next = new Set(prev)
          next.delete(server.id)
          return next
        })
      }
      void run()
    },
    [rebootInfoLoading, sites],
  )

  // Persist the link map to the config file (write-through). The stored shape
  // keys by site id as a string; cfgRef is kept in sync so a later reload of the
  // store sees the change.
  const persistLinks = useCallback((next: Map<number, LocalLink>) => {
    const record: Record<string, LocalLink> = {}
    for (const [id, link] of next) record[String(id)] = link
    cfgRef.current.localSites = record
    void saveConfig({ localSites: record })
  }, [])

  const linkSite = useCallback(
    (siteId: number, link: LocalLink) =>
      setLocalLinks((prev) => {
        const next = new Map(prev).set(siteId, link)
        persistLinks(next)
        return next
      }),
    [persistLinks],
  )

  const unlinkSite = useCallback(
    (siteId: number) =>
      setLocalLinks((prev) => {
        if (!prev.has(siteId)) return prev
        const next = new Map(prev)
        next.delete(siteId)
        persistLinks(next)
        return next
      }),
    [persistLinks],
  )

  const addLocalRoot = useCallback((dir: string) => {
    const trimmed = dir.trim()
    if (!trimmed) return
    setLocalRoots((prev) => {
      if (prev.includes(trimmed)) return prev
      const next = [...prev, trimmed]
      cfgRef.current.localRoots = next
      void saveConfig({ localRoots: next })
      return next
    })
  }, [])

  const openLocalTerminal = useCallback(
    (siteId: number) => {
      const link = localLinks.get(siteId)
      if (!link) return "Not linked — press L to link a local copy"
      if (!resolveLocalLink(link).exists) return "Local path is missing — press L to fix it"
      openTerminalAt(expandPath(link.path), cfgRef.current.terminalApp)
      return "Opening a terminal at the local path…"
    },
    [localLinks],
  )

  const openLocalUrl = useCallback(
    (siteId: number) => {
      const link = localLinks.get(siteId)
      if (!link) return "Not linked — press L to link a local copy"
      if (!link.localUrl) return "No local URL set — press L to add one"
      openUrl(link.localUrl)
      return "Opening the local URL…"
    },
    [localLinks],
  )

  const sshSite = useCallback(
    (siteId: number) => {
      const site = sites.find((s) => s.id === siteId)
      if (!site) return ""
      const server = servers.find((s) => s.id === site.server_id)
      const host = server?.ip_address
      const user = site.site_user ?? cfgRef.current.sshUser
      if (!host || !user) return "Can't SSH — missing site user or server IP"
      openSshSession(user, host, server?.ssh_port, cfgRef.current.terminalApp)
      return `Opening SSH to ${site.domain}…`
    },
    [sites, servers],
  )

  // ---- Privileged SSH-key grant (sudo write-over-SSH) -------------------

  const sudoUserFor = useCallback((serverId: number) => sudoUsers.get(serverId), [sudoUsers])

  // Persist the per-server sudo username (only — the password never touches disk).
  const persistSudoUser = useCallback((serverId: number, user: string) => {
    setSudoUsers((prev) => {
      const next = new Map(prev).set(serverId, user)
      const record: Record<string, { user: string }> = {}
      for (const [id, u] of next) record[String(id)] = { user: u }
      cfgRef.current.sudoUsers = record
      void saveConfig({ sudoUsers: record })
      return next
    })
  }, [])

  const isSudoConnected = useCallback((serverId: number) => sudoConnected.has(serverId), [sudoConnected])

  // Connect sudo on a server: validate the credentials live, then (on success)
  // persist the username, hold the password in memory, and mark the server connected
  // for the session. Returns the verify result so the overlay can show pass/fail.
  const connectSudo = useCallback(
    async (server: Server, user: string, password: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const sudoUser = user.trim()
      if (!sudoUser) return { ok: false, error: "Enter a sudo username." }
      const res = await verifySudo(server, { sudoUser, sudoPassword: password })
      if (!res.ok) return res
      persistSudoUser(server.id, sudoUser)
      sudoPwRef.current.set(server.id, password)
      setSudoConnected((prev) => new Set(prev).add(server.id))
      return { ok: true }
    },
    [persistSudoUser],
  )

  // Disconnect sudo on a server: forget the held password and clear the connected flag.
  const disconnectSudo = useCallback((serverId: number) => {
    sudoPwRef.current.delete(serverId)
    setSudoConnected((prev) => {
      if (!prev.has(serverId)) return prev
      const next = new Set(prev)
      next.delete(serverId)
      return next
    })
  }, [])

  const setPreferredGrantKeys = useCallback((ids: string[]) => {
    cfgRef.current.preferredGrantKeys = ids
    setPreferredGrantKeysState(ids)
    void saveConfig({ preferredGrantKeys: ids })
  }, [])

  // Persist the granted-keys map (only non-empty entries) to config, write-through.
  const persistGrantedKeys = useCallback((next: Map<number, Set<string>>) => {
    const rec: Record<string, string[]> = {}
    for (const [id, set] of next) if (set.size) rec[String(id)] = [...set]
    cfgRef.current.grantedKeys = rec
    void saveConfig({ grantedKeys: rec })
  }, [])

  // Record / forget which keys (by body) Spinup has granted on a site.
  const recordGrantedKeys = useCallback(
    (siteId: number, bodies: string[]) =>
      setGrantedKeys((prev) => {
        const next = new Map(prev)
        const set = new Set(next.get(siteId) ?? [])
        for (const b of bodies) if (b) set.add(b)
        next.set(siteId, set)
        persistGrantedKeys(next)
        return next
      }),
    [persistGrantedKeys],
  )
  const forgetGrantedKeys = useCallback(
    (siteId: number, bodies: string[]) =>
      setGrantedKeys((prev) => {
        if (!prev.has(siteId)) return prev
        const next = new Map(prev)
        const set = new Set(next.get(siteId))
        for (const b of bodies) set.delete(b)
        if (set.size) next.set(siteId, set)
        else next.delete(siteId)
        persistGrantedKeys(next)
        return next
      }),
    [persistGrantedKeys],
  )
  const siteHasGrantedKey = useCallback((siteId: number) => (grantedKeys.get(siteId)?.size ?? 0) > 0, [grantedKeys])
  // Break a site's granted keys into "personal" (yours) vs "machine" (spinup-tui),
  // so the UI can say which is on the site instead of an ambiguous "Spinup key".
  // Before the machine-key body resolves, everything counts as personal (brief).
  const grantedKeyKinds = useCallback(
    (siteId: number): { personal: number; machine: number } => {
      const set = grantedKeys.get(siteId)
      if (!set || set.size === 0) return { personal: 0, machine: 0 }
      let machine = 0
      let personal = 0
      for (const b of set) {
        if (machineKeyBody && b === machineKeyBody) machine++
        else personal++
      }
      return { personal, machine }
    },
    [grantedKeys, machineKeyBody],
  )

  const setGrant = (siteId: number, progress: KeyGrantProgress) =>
    setKeyGrants((prev) => new Map(prev).set(siteId, progress))

  const clearGrantKey = useCallback(
    (siteId: number) =>
      setKeyGrants((prev) => {
        if (!prev.has(siteId)) return prev
        const next = new Map(prev)
        next.delete(siteId)
        return next
      }),
    [],
  )

  // Grant or REVOKE the keys on one or many sites (all on the same server). Each
  // site's progress is tracked independently in keyGrants, so the overlay can show
  // a per-site readout; a bounded pool keeps the SSH fan-out modest (the persistent
  // ControlMaster connection makes the per-site probes cheap). On success, grant
  // records the keys for the row badge; revoke forgets them.
  const runKeyOp = useCallback(
    (sites: Site[], pubkeys: string[], op: "grant" | "revoke") => {
      if (sites.length === 0) return
      const verb = op === "grant" ? "grant" : "remove"
      if (pubkeys.length === 0) {
        for (const s of sites) setGrant(s.id, { status: "error", error: `No keys selected to ${verb}.` })
        return
      }
      const server = servers.find((s) => s.id === sites[0].server_id)
      if (!server) {
        for (const s of sites) setGrant(s.id, { status: "error", error: "Couldn't find the site's server." })
        return
      }
      const sudoUser = sudoUsers.get(server.id)
      if (!sudoUser) {
        for (const s of sites) setGrant(s.id, { status: "error", error: "No sudo user set for this server." })
        return
      }
      const sudoPassword = sudoPwRef.current.get(server.id) ?? ""
      const bodies = pubkeys.map(keyBody)

      // Skip sites already mid-op; queue the rest (so the overlay sees them
      // immediately) and drain with a small worker pool.
      const queue = sites.filter((s) => {
        const ex = keyGrants.get(s.id)
        return !(ex && ex.status !== "done" && ex.status !== "error")
      })
      for (const s of queue) setGrant(s.id, { status: "queued" })

      const CONCURRENCY = 4
      let cursor = 0
      const worker = async () => {
        while (cursor < queue.length) {
          const s = queue[cursor++]
          setGrant(s.id, { status: op === "grant" ? "granting" : "removing" })
          const fn = op === "grant" ? grantSiteSshKey : revokeSiteSshKey
          const res = await fn(server, s, { sudoUser, sudoPassword, pubkeys })
          if (res.ok) {
            if (op === "grant") recordGrantedKeys(s.id, bodies)
            else forgetGrantedKeys(s.id, bodies)
            setGrant(s.id, { status: "done", target: res.target })
          } else {
            // A rejected/stale password means the server is no longer truly connected
            // — disconnect it so the ● disappears and the user reconnects.
            if (/password was rejected|password is required|can't run sudo|couldn't connect/i.test(res.error)) {
              disconnectSudo(server.id)
            }
            setGrant(s.id, { status: "error", error: res.error, target: res.target })
          }
        }
      }
      for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) void worker()
    },
    [keyGrants, servers, sudoUsers, disconnectSudo, recordGrantedKeys, forgetGrantedKeys],
  )

  const startGrantKey = useCallback((sites: Site[], pubkeys: string[]) => runKeyOp(sites, pubkeys, "grant"), [runKeyOp])
  const startRevokeKey = useCallback((sites: Site[], pubkeys: string[]) => runKeyOp(sites, pubkeys, "revoke"), [runKeyOp])

  // Grant the user's REMEMBERED keys (preferredGrantKeys) to the given sites,
  // resolving the saved key bodies to their current key lines. Used by auto-grant
  // flows (e.g. the vanity build) so a created site gets the key with one keypress.
  // Sets a clear error on the sites if there's no saved selection to resolve.
  const startGrantRemembered = useCallback(
    (sites: Site[]) => {
      if (sites.length === 0) return
      void (async () => {
        let lines: string[] = []
        try {
          const [machine, personal] = await Promise.all([ensureSpinupKey(), listPersonalKeys()])
          const all = [...personal, { id: keyBody(machine.pub), line: machine.pub }]
          lines = all.filter((k) => preferredGrantKeys.includes(k.id)).map((k) => k.line)
        } catch {
          /* fall through to the no-keys error below */
        }
        if (lines.length === 0) {
          for (const s of sites) setGrant(s.id, { status: "error", error: "No saved keys to grant — grant one on a site (K) first." })
          return
        }
        startGrantKey(sites, lines)
      })()
    },
    [preferredGrantKeys, startGrantKey],
  )

  // ---- Production DB backup download ------------------------------------

  const setBackup = (siteId: number, progress: DbBackupProgress) =>
    setDbBackups((prev) => new Map(prev).set(siteId, progress))

  const clearDbBackup = useCallback(
    (siteId: number) =>
      setDbBackups((prev) => {
        if (!prev.has(siteId)) return prev
        const next = new Map(prev)
        next.delete(siteId)
        return next
      }),
    [],
  )

  const planDbBackupFor = useCallback(
    (site: Site): PlanResult =>
      planDbBackup(site, servers.find((s) => s.id === site.server_id), cfgRef.current.sshUser, localLinks.get(site.id), new Date()),
    [servers, localLinks],
  )

  const startDbBackup = useCallback(
    (site: Site) => {
      // Ignore a duplicate request while one is already running for this site.
      const existing = dbBackups.get(site.id)
      if (existing && existing.stage !== "done" && existing.stage !== "error") return
      const res = planDbBackupFor(site)
      if (!res.ok) {
        setBackup(site.id, { stage: "error", domain: site.domain, error: res.error })
        return
      }
      // SSH-orchestrated (no event): persist only for visibility/interrupted
      // detection on restart; drop it the moment it settles.
      void saveJob({ id: dbBackupJobId(site.id), kind: "dbBackup", status: "running", startedAt: Date.now(), inputs: { siteId: site.id, domain: site.domain } })
      void runDbBackup(res.plan, site.domain, (p) => {
        setBackup(site.id, p)
        if (p.stage === "done" || p.stage === "error") void removeJob(dbBackupJobId(site.id))
      })
    },
    [dbBackups, planDbBackupFor],
  )

  // ---- Production → local DB sync ---------------------------------------

  const setSync = (siteId: number, progress: DbSyncProgress) =>
    setDbSyncs((prev) => new Map(prev).set(siteId, progress))

  const clearDbSync = useCallback(
    (siteId: number) =>
      setDbSyncs((prev) => {
        if (!prev.has(siteId)) return prev
        const next = new Map(prev)
        next.delete(siteId)
        return next
      }),
    [],
  )

  const planDbSyncFor = useCallback(
    (site: Site): SyncPlanResult =>
      planDbSync(site, servers.find((s) => s.id === site.server_id), cfgRef.current.sshUser, localLinks.get(site.id), new Date()),
    [servers, localLinks],
  )

  const planMediaFallbackFor = useCallback((site: Site): MediaFallbackResult => planMediaFallback(site, localLinks.get(site.id)), [localLinks])

  const startDbSync = useCallback(
    (site: Site) => {
      const existing = dbSyncs.get(site.id)
      if (existing && existing.stage !== "done" && existing.stage !== "error") return
      const res = planDbSyncFor(site)
      if (!res.ok) {
        setSync(site.id, { stage: "error", domain: site.domain, error: res.error })
        return
      }
      // SSH-orchestrated (no event): persist only so a restart can flag it as
      // interrupted (local DB may be partial); drop it the moment it settles.
      void saveJob({ id: dbSyncJobId(site.id), kind: "dbSync", status: "running", startedAt: Date.now(), inputs: { siteId: site.id, domain: site.domain } })
      void runDbSync(res.plan, site.domain, (p) => {
        setSync(site.id, p)
        if (p.stage === "done" || p.stage === "error") void removeJob(dbSyncJobId(site.id))
      })
    },
    [dbSyncs, planDbSyncFor],
  )

  // Compute a linked site's git drift once (cached), fire-and-forget. Stable
  // across renders (uses a ref for the dedup set), so views can call it freely
  // from an effect when a linked site comes into view.
  const ensureDrift = useCallback((siteId: number, linkPath: string) => {
    if (driftRequested.current.has(siteId)) return
    driftRequested.current.add(siteId)
    void gitDrift(linkPath).then((d) => setDrift((prev) => new Map(prev).set(siteId, d)))
  }, [])

  // ---- DNS zone-host lookups -------------------------------------------------

  // Resolve one domain's zone host (cache first). Concurrency-safe — the ref-based
  // in-flight set dedupes, and a fresh cache entry short-circuits unless forced.
  const dnsResolveOne = useCallback(async (domain: string, force: boolean) => {
    const cache = dnsCacheRef.current!
    const key = normalizeDomain(domain)
    if (!key || dnsInFlight.current.has(key)) return
    if (!force && !cache.isStale(key)) return
    dnsInFlight.current.add(key)
    setDnsResolving((prev) => new Set(prev).add(key))
    try {
      const zone = await resolveZone(key)
      await cache.set(key, zone)
      setDnsZones(cache.snapshot())
    } finally {
      dnsInFlight.current.delete(key)
      setDnsResolving((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [])

  // Resolve many domains with a bounded pool (skips fresh/in-flight unless forced).
  const dnsLookupMany = useCallback(
    (domains: string[], force = false) => {
      const cache = dnsCacheRef.current!
      const keys = Array.from(new Set(domains.map(normalizeDomain).filter(Boolean)))
      const queue = keys.filter((k) => !dnsInFlight.current.has(k) && (force || cache.isStale(k)))
      if (queue.length === 0) return
      const CONCURRENCY = 5
      let cursor = 0
      const worker = async () => {
        while (cursor < queue.length) await dnsResolveOne(queue[cursor++], force)
      }
      for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) void worker()
    },
    [dnsResolveOne],
  )

  const domainsForSite = (site: Site): string[] => [
    site.domain,
    ...(site.additional_domains?.map((a) => a.domain) ?? []),
  ]

  const lookupSiteDns = useCallback(
    (site: Site, force = false) => dnsLookupMany(domainsForSite(site), force),
    [dnsLookupMany],
  )

  const lookupServerDns = useCallback(
    (serverId: number, force = false) => {
      const domains: string[] = []
      for (const s of sites) if (s.server_id === serverId) domains.push(...domainsForSite(s))
      dnsLookupMany(domains, force)
    },
    [dnsLookupMany, sites],
  )

  const zoneForDomain = useCallback((domain: string) => dnsZones.get(normalizeDomain(domain)), [dnsZones])
  const isDnsResolving = useCallback((domain: string) => dnsResolving.has(normalizeDomain(domain)), [dnsResolving])

  // ---- Website-hosting record lookups (Phase 3 inventory) --------------------

  // Resolve one hostname's record at its zone's authoritative NS. Records "none"
  // when the hostname has no record (so it isn't retried); a network miss also
  // caches none until a forced refresh.
  const resolveHostingOne = useCallback(async (host: string, apex: string, ns: string[], serverIp: string | null) => {
    if (hostingInFlight.current.has(host)) return
    hostingInFlight.current.add(host)
    setHostingResolving((prev) => new Set(prev).add(host))
    try {
      const ans = await queryAuthoritative(host, "A", ns)
      const own = ans?.find((a) => a.name.toLowerCase() === host)
      const here = !!(serverIp && ans?.some((a) => a.type === "A" && a.value === serverIp))
      const rec: HostRecord = own
        ? { host, apex, type: own.type, ttl: own.ttl, value: own.value, pointsHere: here, checkedAt: Date.now() }
        : { host, apex, type: "none", ttl: null, value: "", pointsHere: false, checkedAt: Date.now() }
      setHostingRecords((prev) => new Map(prev).set(host, rec))
    } finally {
      hostingInFlight.current.delete(host)
      setHostingResolving((prev) => {
        const next = new Set(prev)
        next.delete(host)
        return next
      })
    }
  }, [])

  const resolveServerHosting = useCallback(
    (server: Server, force = false) => {
      const serverIp = server.ip_address ?? null
      const hosts = new Set<string>()
      for (const s of sites) if (s.server_id === server.id) for (const h of candidateHostnames(domainsForSite(s))) hosts.add(h)
      // Only resolve hostnames whose zone NS we already know (needed to query the
      // authoritative server). The rest get picked up when their zone lands and
      // this re-runs (it's cheap — already-resolved/in-flight are skipped).
      const pool: { host: string; apex: string; ns: string[] }[] = []
      for (const host of hosts) {
        if (hostingInFlight.current.has(host)) continue
        if (!force && hostingRecords.has(host)) continue
        const z = dnsZones.get(normalizeDomain(host))
        const ns = z?.zone?.nameservers
        const apex = z?.zone?.apex
        if (!ns || ns.length === 0 || !apex) continue
        pool.push({ host, apex, ns })
      }
      if (pool.length === 0) return
      const CONCURRENCY = 5
      let cursor = 0
      const worker = async () => {
        while (cursor < pool.length) {
          const { host, apex, ns } = pool[cursor++]
          await resolveHostingOne(host, apex, ns, serverIp)
        }
      }
      for (let i = 0; i < Math.min(CONCURRENCY, pool.length); i++) void worker()
    },
    [sites, dnsZones, hostingRecords, resolveHostingOne],
  )

  const hostingFor = useCallback((host: string) => hostingRecords.get(host.toLowerCase()), [hostingRecords])
  const isHostingResolving = useCallback((host: string) => hostingResolving.has(host.toLowerCase()), [hostingResolving])

  // ---- DNS provider connections (Phase 2 access detection) -------------------

  const genConnId = (provider: ConnProvider) =>
    `${provider}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

  const allConnections = useMemo(() => ALL_PROVIDERS.flatMap((p) => connections[p]), [connections])
  const connectionsFor = useCallback((provider: ConnProvider) => connections[provider], [connections])

  // Zones we can reach, keyed by `${provider}:${apex}` → list of candidate
  // accounts (connection id + label + the account-zone's assigned nameservers).
  // Provider-scoped: a Cloudflare-hosted zone is only reachable via a connected
  // CLOUDFLARE account.
  const reachable = useMemo(() => {
    const m = new Map<string, { id: string; label: string; ns: string[] }[]>()
    for (const conn of allConnections) {
      const v = providerZones.get(conn.id)
      if (v?.ok)
        for (const z of v.zones) {
          const key = `${conn.provider}:${z.apex}`
          const list = m.get(key) ?? []
          list.push({ id: conn.id, label: conn.label || conn.id, ns: z.nameservers ?? [] })
          m.set(key, list)
        }
    }
    return m
  }, [allConnections, providerZones])

  // Pick the candidate account that actually SERVES a zone, using the live
  // authoritative nameservers when the account's NS are known (catches stale /
  // duplicate zones across accounts). When no NS are known (e.g. AWS), fall back
  // to membership — provider-scoping already guarantees the right provider.
  const matchedAccount = useCallback(
    (apex: string, hostKey: string, liveNs: string[]): { editable: boolean; label: string; id: string } => {
      const prov = apiProviderFor(hostKey)
      if (!prov) return { editable: false, label: "", id: "" }
      const candidates = reachable.get(`${prov}:${apex}`) ?? []
      if (candidates.length === 0) return { editable: false, label: "", id: "" }
      const withNs = candidates.filter((c) => c.ns.length > 0)
      // If we know any candidate's NS, require a live match to count as editable.
      if (withNs.length > 0 && liveNs.length > 0) {
        const live = withNs.find((c) => nameserversMatch(c.ns, liveNs))
        if (live) return { editable: true, label: live.label, id: live.id }
        // Some candidates have NS but none serve the live zone → only editable if
        // another candidate's NS are unknown (can't disprove it).
        const unknown = candidates.find((c) => c.ns.length === 0)
        return unknown ? { editable: true, label: unknown.label, id: unknown.id } : { editable: false, label: "", id: "" }
      }
      // No NS info to match on → membership (provider-scoped) is the best we have.
      return { editable: true, label: candidates[0].label, id: candidates[0].id }
    },
    [reachable],
  )

  const accessForZone = useCallback(
    (apex: string, hostKey: string, liveNs: string[]): AccessState => {
      const prov = apiProviderFor(hostKey)
      if (prov) {
        if (matchedAccount(apex, hostKey, liveNs).editable) return "editable"
        // Not reachable via API: providers with a console fallback (GoDaddy, whose
        // API is gated) show `web`; others show `needs-key`.
        return PROVIDER_REGISTRY[prov].console ? "web" : "needs-key"
      }
      if (PROVIDER_CONSOLE[hostKey]) return "web"
      return "unknown"
    },
    [matchedAccount],
  )

  const accountForZone = useCallback(
    (apex: string, hostKey: string, liveNs: string[]) => matchedAccount(apex, hostKey, liveNs).label,
    [matchedAccount],
  )

  const connForZone = useCallback(
    (apex: string, hostKey: string, liveNs: string[]): Connection | null => {
      const m = matchedAccount(apex, hostKey, liveNs)
      if (!m.editable || !m.id) return null
      return allConnections.find((c) => c.id === m.id) ?? null
    },
    [matchedAccount, allConnections],
  )

  // Persist the stored (non-env) connections to config, keeping cfgRef in sync.
  const persistConnections = useCallback((next: Record<ConnProvider, Connection[]>) => {
    cfgRef.current.providerConnections = next
    const providers: StoredProviders = {}
    for (const p of ALL_PROVIDERS) {
      providers[p] = next[p].filter((c) => !c.env).map((c) => ({ id: c.id, label: c.label, creds: c.creds }))
    }
    void saveConfig({ providers })
  }, [])

  // Verify a connection and write the result through to the cache.
  const verifyAndCache = useCallback(async (conn: Connection): Promise<VerifyResult> => {
    const res = await verifyProviderConnection(conn)
    await providersCacheRef.current!.set(conn.id, {
      ok: res.ok,
      zones: res.zones,
      accountLabel: res.accountLabel,
      error: res.error,
      verifiedAt: Date.now(),
    })
    setProviderZones(providersCacheRef.current!.snapshot())
    return res
  }, [])

  const addConnection = useCallback(
    async (provider: ConnProvider, label: string, creds: Record<string, string>): Promise<VerifyResult> => {
      const trimmed: Record<string, string> = {}
      for (const [k, v] of Object.entries(creds)) trimmed[k] = v.trim()
      const conn: Connection = { id: genConnId(provider), provider, label: label.trim(), creds: trimmed }
      const res = await verifyAndCache(conn)
      if (!res.ok) {
        // Don't keep a credential we couldn't verify; drop its cache entry.
        await providersCacheRef.current!.delete(conn.id)
        setProviderZones(providersCacheRef.current!.snapshot())
        return res
      }
      conn.label = conn.label || res.accountLabel || provider
      setConnections((prev) => {
        const next = { ...prev, [provider]: [...prev[provider], conn] }
        persistConnections(next)
        return next
      })
      return res
    },
    [verifyAndCache, persistConnections],
  )

  const removeConnection = useCallback(
    (id: string) => {
      setConnections((prev) => {
        let changed = false
        const next = {} as Record<ConnProvider, Connection[]>
        for (const p of ALL_PROVIDERS) {
          const filtered = prev[p].filter((c) => c.id !== id || c.env) // env can't be removed
          if (filtered.length !== prev[p].length) changed = true
          next[p] = filtered
        }
        if (!changed) return prev
        persistConnections(next)
        void providersCacheRef.current!.delete(id).then(() => setProviderZones(providersCacheRef.current!.snapshot()))
        return next
      })
    },
    [persistConnections],
  )

  const verifyConnectionById = useCallback(
    (id: string) => {
      const conn = allConnections.find((c) => c.id === id)
      if (conn) void verifyAndCache(conn)
    },
    [allConnections, verifyAndCache],
  )

  // ---- DNS record TTL change (Phase 3, first write) -------------------------

  const getZoneRecord = useCallback(
    async (connId: string, apex: string, name: string, type: string): Promise<RecordResult> => {
      const conn = allConnections.find((c) => c.id === connId)
      const provider = conn ? recordProviderFor(conn.provider) : null
      if (!conn || !provider) return { ok: false, zoneId: "", error: "No reachable connection for this zone." }
      return provider.getRecord(conn.creds, apex, name, type)
    },
    [allConnections],
  )

  const setTtlWrite = (key: string, progress: TtlWriteProgress) =>
    setTtlWrites((prev) => new Map(prev).set(key, progress))

  // The latest TTL write for a given hostname+type, if any — so the inventory can
  // show an "updating"/just-changed status on the matching record row.
  const ttlWriteForHost = useCallback(
    (host: string, type: string): TtlWriteProgress | undefined => {
      const h = host.toLowerCase()
      for (const p of ttlWrites.values()) if (p.host === h && p.type === type) return p
      return undefined
    },
    [ttlWrites],
  )

  const clearTtlWrite = useCallback(
    (key: string) =>
      setTtlWrites((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      }),
    [],
  )

  const startTtlChange = useCallback(
    (connId: string, zoneId: string, record: DnsRecord, ttl: number) => {
      const existing = ttlWrites.get(record.key)
      if (existing && isTtlWriteInFlight(existing)) return // one change per record at a time

      // Stamp every progress update with the record's host/type so the inventory can
      // match an in-flight write back to its row after the editor closes.
      const put = (status: string, error?: string) =>
        setTtlWrite(record.key, { ttl, status, host: record.name.toLowerCase(), type: record.type, ...(error ? { error } : {}) })

      const conn = allConnections.find((c) => c.id === connId)
      const provider = conn ? recordProviderFor(conn.provider) : null
      if (!conn || !provider) {
        put(TTL_FAIL, "Lost the provider connection — reopen the records view.")
        return
      }

      const run = async () => {
        put("queued")
        let res
        try {
          res = await provider.setTtl(conn.creds, zoneId, record, ttl)
        } catch (err) {
          put(TTL_FAIL, (err as Error).message)
          return
        }
        if (!res.ok) {
          put(TTL_FAIL, res.error || "The provider rejected the change.")
          return
        }
        // No poll id (Cloudflare) → already applied. Otherwise poll to INSYNC.
        if (!res.pollId || !provider.pollChange) {
          put(TTL_DONE)
          return
        }
        const pollId = res.pollId
        put("pending")
        const poll = async () => {
          try {
            const status = await provider.pollChange!(conn.creds, pollId)
            if (status === "done") put(TTL_DONE)
            else if (status === "failed") put(TTL_FAIL, "The change failed to propagate.")
            else setTimeout(() => void poll(), TTL_POLL_MS)
          } catch (err) {
            put(TTL_FAIL, (err as Error).message)
          }
        }
        setTimeout(() => void poll(), TTL_POLL_MS)
      }
      void run()
    },
    [allConnections, ttlWrites],
  )

  // ---- Vanity site (connect a fresh, empty server) ----------------------

  // The step machine. Each step performs its work then hands off to the next; it
  // re-enters at job.step (so resume continues mid-flight). Steps are written to be
  // idempotent where they can't re-attach to a remote handle (site/seed), so a
  // resume never duplicates work.
  const driveVanity = useCallback(
    (job: VanityJob) => {
      const persist = (j: VanityJob) => {
        setVanityJob(j)
        // Forget only a truly-finished build. An errored/incomplete one stays
        // persisted so it's reopenable (and survives a restart) until the user
        // retries it to completion or explicitly discards it.
        if (j.step === "done") void removeJob(VANITY_JOB_ID)
        else void saveJob({ id: VANITY_JOB_ID, kind: "vanity", status: "running", startedAt: j.startedAt, inputs: j })
      }
      const fail = (j: VanityJob, step: VanityStep, error: string) => persist({ ...j, step: "error", failedStep: step, error })
      const apiMsg = (err: unknown) => (err instanceof ApiError ? err.message : (err as Error).message)

      const pollEvent = (eventId: number, step: VanityStep, j: VanityJob, onDone: () => void) => {
        const poll = async () => {
          try {
            const e = await client.getEvent(eventId)
            if (SERVER_FAIL.has(e.status)) return fail(j, step, e.output?.trim() || `The ${step} step failed on SpinupWP.`)
            if (SERVER_DONE.has(e.status) || e.finished_at) return onDone()
            setTimeout(() => void poll(), VANITY_POLL_MS)
          } catch (err) {
            fail(j, step, apiMsg(err))
          }
        }
        setTimeout(() => void poll(), VANITY_POLL_MS)
      }

      async function doDns(j: VanityJob) {
        persist({ ...j, step: "dns" })
        const conn = j.connId ? allConnections.find((c) => c.id === j.connId) : null
        const provider = conn ? recordProviderFor(conn.provider) : null
        if (!conn || !provider?.createRecord) {
          return fail(j, "dns", "No DNS provider connection serves this zone — connect one in the DNS view first.")
        }
        let res
        try {
          res = await provider.createRecord(conn.creds, j.apex, j.hostname, "A", j.serverIp, 300)
        } catch (err) {
          return fail(j, "dns", (err as Error).message)
        }
        if (!res.ok) return fail(j, "dns", res.error || "The DNS provider rejected the A record.")
        const next: VanityJob = { ...j, step: "propagate", propagateStartedAt: Date.now(), propagateTimedOut: false }
        if (res.pollId && provider.pollChange) {
          const pollId = res.pollId
          const poll = async () => {
            try {
              const st = await provider.pollChange!(conn.creds, pollId)
              if (st === "failed") return fail(j, "dns", "The DNS change failed to apply at the provider.")
              if (st === "done") return void doPropagate(next)
              setTimeout(() => void poll(), VANITY_POLL_MS)
            } catch (err) {
              fail(j, "dns", (err as Error).message)
            }
          }
          setTimeout(() => void poll(), VANITY_POLL_MS)
        } else {
          void doPropagate(next)
        }
      }

      async function doPropagate(j: VanityJob) {
        const startedAt = j.propagateStartedAt ?? Date.now()
        persist({ ...j, step: "propagate", propagateStartedAt: startedAt, propagateTimedOut: false })
        const check = async () => {
          if (await aRecordResolves(j.hostname, j.serverIp)) return void doSite({ ...j, step: "site" })
          if (Date.now() - startedAt > VANITY_PROPAGATE_TIMEOUT_MS) {
            return persist({ ...j, step: "propagate", propagateStartedAt: startedAt, propagateTimedOut: true })
          }
          setTimeout(() => void check(), VANITY_POLL_MS)
        }
        void check()
      }

      async function doSite(j: VanityJob) {
        persist({ ...j, step: "site", propagateTimedOut: false })
        // Idempotent: if the site already exists (e.g. resuming), reuse it.
        let existing
        try {
          existing = (await client.listSites(j.serverId)).find((s) => s.domain === j.hostname)
        } catch {
          /* fall through to create */
        }
        const afterSite = (siteId: number | undefined, httpsOn: boolean) => {
          const withSite = { ...j, siteId }
          if (j.sslSkipped || httpsOn) return void doSshkey({ ...withSite, step: "sshkey" })
          return void doHttps({ ...withSite, step: "https" })
        }
        if (existing) return afterSite(existing.id, existing.https?.enabled === true)
        let ev
        try {
          ev = await client.createSite({ server_id: j.serverId, domain: j.hostname, site_user: j.siteUser, installation_method: "blank" })
        } catch (err) {
          return fail(j, "site", apiMsg(err))
        }
        pollEvent(ev.event_id, "site", j, async () => {
          await refresh()
          let siteId: number | undefined
          try {
            siteId = (await client.listSites(j.serverId)).find((s) => s.domain === j.hostname)?.id
          } catch {
            /* https step guards on a missing siteId */
          }
          afterSite(siteId, false)
        })
      }

      async function doHttps(j: VanityJob) {
        if (!j.siteId) return fail(j, "https", "Couldn't find the new site to enable HTTPS — open it in SpinupWP to add SSL.")
        persist({ ...j, step: "https" })
        let ev
        try {
          ev = await client.enableHttps(j.siteId)
        } catch (err) {
          return fail(j, "https", apiMsg(err))
        }
        pollEvent(ev.event_id, "https", j, () => void doSshkey({ ...j, step: "sshkey" }))
      }

      // Manual park: the user adds their SSH key in SpinupWP (deep-link), then
      // advances via vanitySshKeyDone(). We just surface the step.
      function doSshkey(j: VanityJob) {
        persist({ ...j, step: "sshkey" })
      }

      async function doSeed(j: VanityJob) {
        persist({ ...j, step: "seed" })
        const res = await seedVanityIndex({ host: j.serverIp, user: j.siteUser, port: j.port, domain: j.hostname, publicFolder: j.publicFolder })
        if (!res.ok) return fail(j, "seed", res.error || "Couldn't seed index.php over SSH.")
        await refresh()
        persist({ ...j, step: "done" })
      }

      switch (job.step) {
        case "dns":
          return void doDns(job)
        case "propagate":
          return void doPropagate(job)
        case "site":
          return void doSite(job)
        case "https":
          return void doHttps(job)
        case "sshkey":
          return doSshkey(job)
        case "seed":
          return void doSeed(job)
        default:
          return
      }
    },
    [client, allConnections, refresh],
  )

  const startVanity = useCallback(
    (server: Server, opts: { siteUser: string; skipSsl?: boolean }) => {
      if (vanityJob && isVanityInFlight(vanityJob)) return // one vanity build at a time
      const startedAt = Date.now()
      const base: VanityJob = {
        serverId: server.id,
        serverIp: server.ip_address ?? "",
        hostname: server.name,
        apex: "",
        siteUser: opts.siteUser,
        publicFolder: "/",
        port: server.ssh_port ?? null,
        step: "dns",
        startedAt,
        sslSkipped: opts.skipSsl ?? false,
      }
      const run = async () => {
        const zone = await resolveZone(server.name)
        if (!zone) return setVanityJob({ ...base, step: "error", failedStep: "dns", error: `Couldn't find the DNS zone for ${server.name}.` })
        const conn = connForZone(zone.apex, zone.providerKey, zone.nameservers)
        const job: VanityJob = { ...base, apex: zone.apex, connId: conn?.id }
        if (!conn) return setVanityJob({ ...job, step: "error", failedStep: "dns", error: `No editable DNS connection serves ${zone.apex} — connect one in the DNS view first.` })
        driveVanity(job)
      }
      void run()
    },
    [vanityJob, connForZone, driveVanity],
  )

  const vanitySshKeyDone = useCallback(() => {
    if (!vanityJob || vanityJob.step !== "sshkey") return
    const next: VanityJob = { ...vanityJob, step: "seed" }
    setVanityJob(next)
    driveVanity(next)
  }, [vanityJob, driveVanity])

  // From the propagation-timeout prompt: skip SSL → create the site now and bypass
  // the HTTPS step (SSL can be added later in SpinupWP).
  const vanitySkipSsl = useCallback(() => {
    if (!vanityJob || vanityJob.step !== "propagate") return
    const next: VanityJob = { ...vanityJob, sslSkipped: true, propagateTimedOut: false, step: "site" }
    setVanityJob(next)
    driveVanity(next)
  }, [vanityJob, driveVanity])

  const vanityKeepWaiting = useCallback(() => {
    if (!vanityJob || vanityJob.step !== "propagate") return
    const next: VanityJob = { ...vanityJob, propagateTimedOut: false, propagateStartedAt: Date.now() }
    setVanityJob(next)
    driveVanity(next)
  }, [vanityJob, driveVanity])

  const vanityRetry = useCallback(() => {
    if (!vanityJob || vanityJob.step !== "error") return
    const next: VanityJob = { ...vanityJob, step: vanityJob.failedStep ?? "dns", error: undefined, failedStep: undefined }
    setVanityJob(next)
    driveVanity(next)
  }, [vanityJob, driveVanity])

  const clearVanity = useCallback(() => {
    setVanityJob(null)
    void removeJob(VANITY_JOB_ID)
  }, [])

  // Resume persisted jobs after a restart. Runs exactly once (the ref guards
  // against dep churn re-firing it). Iterates every in-flight job and dispatches by
  // kind: event-backed jobs (newServer, phpUpgrade) reconnect their poller via the
  // stored event id; the vanity job re-enters its step machine (idempotent steps);
  // SSH-orchestrated jobs (dbSync, dbBackup) can't reconnect a dead process, so
  // they're surfaced as interrupted and dropped from the persisted set.
  const resumedRef = useRef(false)
  useEffect(() => {
    if (resumedRef.current) return
    resumedRef.current = true
    for (const job of Object.values(cfgRef.current.jobs ?? {})) {
      if (job.status === "done" || job.status === "failed") continue
      const inp = (job.inputs ?? {}) as { hostname?: string; siteId?: number; version?: string; domain?: string }
      switch (job.kind) {
        case "newServer":
          if (job.eventId == null) {
            void removeJob(job.id)
            break
          }
          {
            const hostname = inp.hostname ?? "your server"
            setNewServerJob({ hostname, status: job.status, startedAt: job.startedAt, eventId: job.eventId })
            trackServerEvent(job.eventId, hostname, job.startedAt)
          }
          break
        case "phpUpgrade":
          if (job.eventId == null || inp.siteId == null || !inp.version) {
            void removeJob(job.id)
            break
          }
          setUpgrade(inp.siteId, { target: inp.version, status: job.status })
          trackPhpUpgradeEvent(inp.siteId, inp.version, job.eventId)
          break
        case "vanity": {
          const vj = job.inputs as VanityJob | undefined
          if (!vj) {
            void removeJob(job.id)
            break
          }
          setVanityJob(vj)
          // sshkey is a manual park — just re-show it. Every other step re-enters
          // the (idempotent) machine and continues.
          if (vj.step !== "sshkey") driveVanity(vj)
          break
        }
        case "dbSync":
          if (inp.siteId != null) setSync(inp.siteId, { stage: "error", domain: inp.domain ?? "", error: INTERRUPTED_SYNC_MSG })
          void removeJob(job.id)
          break
        case "dbBackup":
          if (inp.siteId != null) setBackup(inp.siteId, { stage: "error", domain: inp.domain ?? "", error: INTERRUPTED_BACKUP_MSG })
          void removeJob(job.id)
          break
        default:
          void removeJob(job.id) // unknown/unresumable kind — clear it
      }
    }
  }, [trackServerEvent, trackPhpUpgradeEvent, driveVanity])

  const value: StoreValue = {
    servers,
    sites,
    events,
    loading,
    ready,
    error,
    lastUpdated,
    updateInfo,
    client,
    route,
    setRoute,
    refresh,
    inputMode,
    setInputMode,
    overlayOpen,
    setOverlayOpen,
    healthServer,
    setHealthServer,
    phpUpgradeSite,
    setPhpUpgradeSite,
    phpUpgrades,
    startPhpUpgrade,
    clearPhpUpgrade,
    serverActionsServer,
    setServerActionsServer,
    serverOps,
    startServerOp,
    clearServerOp,
    newServerOpen,
    setNewServerOpen,
    newServerSource,
    setNewServerSource,
    newServerJob,
    startNewServer,
    clearNewServer,
    vanityServer,
    setVanityServer,
    vanityJob,
    startVanity,
    vanitySshKeyDone,
    vanitySkipSsl,
    vanityKeepWaiting,
    vanityRetry,
    clearVanity,
    providerMetadata,
    providerMetadataLoading,
    providerMetadataError,
    loadProviderMetadata,
    serverProviders,
    saveServerProviderId,
    grantKeySite,
    setGrantKeySite,
    keyGrants,
    startGrantKey,
    startRevokeKey,
    startGrantRemembered,
    clearGrantKey,
    preferredGrantKeys,
    setPreferredGrantKeys,
    siteHasGrantedKey,
    grantedKeyKinds,
    grantedKeys,
    forgetGrantedKeys,
    sudoUserFor,
    sudoConnectServer,
    setSudoConnectServer,
    isSudoConnected,
    connectSudo,
    disconnectSudo,
    localLinkSite,
    setLocalLinkSite,
    localLinks,
    linkSite,
    unlinkSite,
    localRoots,
    addLocalRoot,
    discoverOpen,
    setDiscoverOpen,
    forgottenOpen,
    setForgottenOpen,
    forgottenStack,
    setForgottenStack,
    linkReturnToForgotten,
    setLinkReturnToForgotten,
    openLocalTerminal,
    openLocalUrl,
    sshSite,
    dbBackupSite,
    setDbBackupSite,
    dbBackups,
    planDbBackupFor,
    startDbBackup,
    clearDbBackup,
    dbSyncSite,
    setDbSyncSite,
    mediaFallbackSite,
    setMediaFallbackSite,
    planMediaFallbackFor,
    dbSyncs,
    planDbSyncFor,
    startDbSync,
    clearDbSync,
    drift,
    ensureDrift,
    rebootInfo,
    rebootInfoLoading,
    rebootInfoErrors,
    loadRebootInfo,
    sshUser: cfgRef.current.sshUser,
    localSync: cfgRef.current.localSync,
    accountSlug: cfgRef.current.accountSlug,
    sitesForServer,
    serverById,
    probes,
    probingIds,
    probeErrors,
    runProbe,
    runProbeMany,
    isProbeStale,
    dnsZones,
    dnsResolving,
    lookupSiteDns,
    lookupServerDns,
    zoneForDomain,
    isDnsResolving,
    hostingRecords,
    resolveServerHosting,
    hostingFor,
    isHostingResolving,
    dnsInventoryServer,
    dnsInventoryFocusSiteId,
    setDnsInventoryServer,
    setDnsInventoryFocusSiteId,
    connections,
    connectionsFor,
    connectionCount: allConnections.length,
    providerZones,
    addConnection,
    removeConnection,
    verifyConnectionById,
    accessForZone,
    accountForZone,
    connForZone,
    connectZoneTarget,
    setConnectZoneTarget,
    dnsRecordsTarget,
    setDnsRecordsTarget,
    ttlWrites,
    getZoneRecord,
    ttlWriteForHost,
    startTtlChange,
    clearTtlWrite,
    isPhpEol,
    offeredPhpVersions,
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

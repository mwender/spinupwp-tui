// Global data + navigation store, exposed via React context.
//
// Holds the API client, the fetched collections (servers / sites / events),
// loading + error state, and the active navigation route. A single source of
// truth keeps the splash screen, header, and views in sync, and lets any view
// trigger a refresh.

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { SpinupWPClient, ApiError, type ServerService } from "../api/client.ts"
import type { Server, Site, Event } from "../api/types.ts"
import { loadConfig, saveConfig } from "../config.ts"
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
import type { StoredProviders } from "../config.ts"
import { fetchRebootInfo, type RebootInfo } from "../lib/ssh.ts"
import { StackCache, siteSignature, type CachedProbe } from "../lib/stackCache.ts"
import { resolvePhpEolDates, refreshPhpEolDates, isPhpEol as isPhpEolWith, offeredPhpVersions as offeredPhpVersionsWith, type PhpEolDates } from "../lib/phpEol.ts"

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
  // Reboot "why" — SSH-probed Ubuntu reboot-required detail, keyed by server id.
  rebootInfo: Map<number, RebootInfo>
  rebootInfoLoading: Set<number>
  rebootInfoErrors: Map<number, string>
  loadRebootInfo: (server: Server) => void
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
  // Local git drift for linked sites, keyed by site id (null = not a git repo,
  // undefined = not yet computed). Computed lazily + cached; cleared on refresh.
  drift: Map<number, Drift | null>
  ensureDrift: (siteId: number, linkPath: string) => void
  // Optional SSH user override for the health view (from env/config).
  sshUser: string | null
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
  const [route, setRoute] = useState<Route>("dashboard")
  const [inputMode, setInputMode] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [healthServer, setHealthServer] = useState<Server | null>(null)
  const [phpUpgradeSite, setPhpUpgradeSite] = useState<Site | null>(null)
  const [phpUpgrades, setPhpUpgrades] = useState<Map<number, PhpUpgradeProgress>>(new Map())
  const [serverActionsServer, setServerActionsServer] = useState<Server | null>(null)
  const [serverOps, setServerOps] = useState<Map<number, ServerOpProgress>>(new Map())
  const [localLinkSite, setLocalLinkSite] = useState<Site | null>(null)
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
    (siteId: number) =>
      setPhpUpgrades((prev) => {
        if (!prev.has(siteId)) return prev
        const next = new Map(prev)
        next.delete(siteId)
        return next
      }),
    [],
  )

  const startPhpUpgrade = useCallback(
    (site: Site, version: string) => {
      // Ignore a duplicate request while one is already running for this site.
      const existing = phpUpgrades.get(site.id)
      if (existing && existing.status !== UPGRADE_DONE && existing.status !== UPGRADE_FAIL) return

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

        const poll = async () => {
          try {
            const ev = await client.getEvent(eventId)
            if (ev.status === UPGRADE_DONE) {
              await refresh() // pull the new php_version into the store…
              clearPhpUpgrade(site.id) // …then the row reflects truth, no marker needed
            } else if (ev.status === UPGRADE_FAIL) {
              setUpgrade(site.id, {
                target: version,
                status: UPGRADE_FAIL,
                error: ev.output?.trim() || "The upgrade event failed on SpinupWP.",
              })
            } else {
              setUpgrade(site.id, { target: version, status: ev.status })
              setTimeout(() => void poll(), UPGRADE_POLL_MS)
            }
          } catch (err) {
            const msg = err instanceof ApiError ? err.message : (err as Error).message
            setUpgrade(site.id, { target: version, status: UPGRADE_FAIL, error: msg })
          }
        }
        setTimeout(() => void poll(), UPGRADE_POLL_MS)
      }
      void run()
    },
    [client, refresh, clearPhpUpgrade, phpUpgrades],
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

  const value: StoreValue = {
    servers,
    sites,
    events,
    loading,
    ready,
    error,
    lastUpdated,
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
    drift,
    ensureDrift,
    rebootInfo,
    rebootInfoLoading,
    rebootInfoErrors,
    loadRebootInfo,
    sshUser: cfgRef.current.sshUser,
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

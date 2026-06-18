// Global data + navigation store, exposed via React context.
//
// Holds the API client, the fetched collections (servers / sites / events),
// loading + error state, and the active navigation route. A single source of
// truth keeps the splash screen, header, and views in sync, and lets any view
// trigger a refresh.

import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { SpinupWPClient, ApiError } from "../api/client.ts"
import type { Server, Site, Event } from "../api/types.ts"
import { loadConfig } from "../config.ts"
import { probeSite } from "../lib/probe.ts"
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
    isPhpEol,
    offeredPhpVersions,
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

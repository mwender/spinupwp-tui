// Global data + navigation store, exposed via React context.
//
// Holds the API client, the fetched collections (servers / sites / events),
// loading + error state, and the active navigation route. A single source of
// truth keeps the splash screen, header, and views in sync, and lets any view
// trigger a refresh.

import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { SpinupWPClient, ApiError, type ServerService } from "../api/client.ts"
import type { Server, Site, Event } from "../api/types.ts"
import { loadConfig, saveConfig } from "../config.ts"
import { resolveLocalLink, expandPath, normalizeLink, type LocalLink } from "../lib/local.ts"
import type { Stack } from "../lib/stack.ts"
import { openTerminalAt, openUrl, openSshSession } from "../lib/open.ts"
import { gitDrift, type Drift } from "../lib/gitStatus.ts"
import { probeSite } from "../lib/probe.ts"
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
    isPhpEol,
    offeredPhpVersions,
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

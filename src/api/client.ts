// Thin typed wrapper around the SpinupWP REST API using fetch + Bearer auth.
// Reads (GET) work with any token. The handful of write methods (e.g.
// upgradeSitePhp) need a Read/Write-scoped token; since the API exposes no
// token-scope endpoint, a write that comes back 403 is treated as "token is
// read-only" (see mutate()).

import type {
  ApiList,
  ApiSingle,
  Server,
  Site,
  Event,
  ProviderMetadata,
  CreateServerPayload,
  CreateSitePayload,
  AdditionalDomain,
  AddDomainPayload,
} from "./types.ts"

// The restartable services SpinupWP exposes (POST /servers/{id}/services/{svc}/restart).
export type ServerService = "nginx" | "php" | "mysql" | "redis"

export class ApiError extends Error {
  status: number
  body?: string
  constructor(message: string, status: number, body?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
}

export interface ClientOptions {
  token: string
  baseUrl: string
}

// The public surface the store (and Onboarding) actually calls. Extracted so a fake
// implementation (see src/dev/mockClient.ts, used by SPINUP_DEV_MODE) can stand in for
// SpinupWPClient wherever it's consumed, without either side depending on the other.
export interface SpinupWPClientLike {
  validateToken(): Promise<{ ok: true } | { ok: false; reason: string }>
  listServers(): Promise<Server[]>
  getServer(id: number): Promise<Server>
  providerMetadata(provider: string): Promise<ProviderMetadata>
  createServer(payload: CreateServerPayload): Promise<{ event_id: number }>
  listSites(serverId?: number): Promise<Site[]>
  getSite(id: number): Promise<Site>
  createSite(payload: CreateSitePayload): Promise<{ event_id: number }>
  enableHttps(siteId: number): Promise<{ event_id: number }>
  disableHttps(siteId: number): Promise<{ event_id: number } | undefined>
  purgePageCache(siteId: number): Promise<{ event_id: number }>
  purgeObjectCache(siteId: number): Promise<{ event_id: number }>
  listSiteDomains(siteId: number): Promise<AdditionalDomain[]>
  addSiteDomain(siteId: number, payload: AddDomainPayload): Promise<{ event_id: number }>
  listEvents(maxPages?: number): Promise<Event[]>
  getEvent(id: number): Promise<Event>
  upgradeSitePhp(siteId: number, phpVersion: string): Promise<{ event_id: number }>
  rebootServer(serverId: number): Promise<{ event_id: number }>
  restartService(serverId: number, service: ServerService): Promise<{ event_id: number }>
}

const MAX_PAGES = 100 // hard safety cap when auto-paginating

// ---- Rate-limit awareness -------------------------------------------------
// SpinupWP sends X-RateLimit-Remaining on every response (Laravel throttle,
// 1-minute windows). All traffic funnels through fetchWithRateLimit below:
// PROACTIVE pacing — when the window is nearly spent, spread the remaining
// requests across what's left of it instead of slamming into the wall — plus
// REACTIVE Retry-After backoff on 429 (safe to retry: a 429 was rejected before
// any processing). Module-level so every client instance shares one budget.
// Born from the 2026-07-02 prod clone retry, where three concurrent site workers'
// event polling burned the window and made SUCCESSFUL operations look failed.
let rlRemaining = Infinity
let rlResetAt = 0
const RL_LOW_WATER = 8 // start pacing when fewer than this many requests remain
const RL_MAX_RETRIES = 3
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function rlUpdate(headers: Headers): void {
  const rem = Number(headers.get("x-ratelimit-remaining"))
  if (Number.isFinite(rem)) rlRemaining = rem
  // No reset header outside 429s — assume the standard 1-minute window rolls over.
  if (rlResetAt < Date.now()) rlResetAt = Date.now() + 60_000
}

async function rlGate(): Promise<void> {
  if (rlRemaining > RL_LOW_WATER) return
  const windowLeft = Math.max(0, rlResetAt - Date.now())
  const delay = rlRemaining <= 1 ? windowLeft : Math.ceil(windowLeft / Math.max(1, rlRemaining))
  if (delay > 0) await sleep(delay + Math.random() * 300)
}

export class SpinupWPClient implements SpinupWPClientLike {
  private token: string
  private baseUrl: string

  constructor(opts: ClientOptions) {
    this.token = opts.token
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
  }

  // Gate → fetch → learn from headers; on 429 wait out Retry-After (default 20s)
  // and retry a few times before surfacing it. Network errors become ApiError(0).
  private async fetchWithRateLimit(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await rlGate()
      let res: Response
      try {
        res = await fetch(url, init)
      } catch (err) {
        throw new ApiError(`Network error reaching the SpinupWP API: ${(err as Error).message}`, 0)
      }
      rlUpdate(res.headers)
      if (res.status === 429 && attempt < RL_MAX_RETRIES) {
        const ra = Number(res.headers.get("retry-after"))
        const waitMs = (Number.isFinite(ra) && ra > 0 ? ra : 20) * 1000
        rlRemaining = 0
        rlResetAt = Date.now() + waitMs
        await sleep(waitMs + Math.random() * 500)
        continue
      }
      return res
    }
  }

  private async request<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
      }
    }

    const res = await this.fetchWithRateLimit(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "User-Agent": "spinupwp-tui",
      },
    })

    if (res.status === 401) {
      throw new ApiError("Unauthorized — your access token was rejected (401).", 401)
    }
    if (res.status === 403) {
      throw new ApiError("Forbidden — this token lacks permission for that resource (403).", 403)
    }
    if (res.status === 429) {
      throw new ApiError("Rate limited by the SpinupWP API (429). Try again shortly.", 429)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new ApiError(`SpinupWP API error (HTTP ${res.status}).`, res.status, body)
    }

    return (await res.json()) as T
  }

  // Write request (POST/PUT/PATCH/DELETE) with a JSON body. A 403 here almost
  // always means the token lacks Read/Write scope — there's no scope endpoint to
  // check up front, so we detect it by attempting the write and translating the
  // 403 into an actionable message. All other statuses mirror request().
  private async mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
    const url = this.baseUrl + path
    const res = await this.fetchWithRateLimit(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "spinupwp-tui",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (res.status === 401) {
      throw new ApiError("Unauthorized — your access token was rejected (401).", 401)
    }
    if (res.status === 403) {
      throw new ApiError(
        "Your token is read-only — this action needs a Read/Write token. Run `spinup login` to set one.",
        403,
      )
    }
    if (res.status === 429) {
      throw new ApiError("Rate limited by the SpinupWP API (429). Try again shortly.", 429)
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "")
      throw new ApiError(`SpinupWP API error (HTTP ${res.status}).`, res.status, errBody)
    }

    // Some write endpoints (e.g. PHP upgrade) return a bare body, others 204.
    if (res.status === 204) return undefined as T
    return (await res.json().catch(() => undefined)) as T
  }

  // Fetch a single page of a list resource.
  private listPage<T>(path: string, page: number, params?: Record<string, string | number | undefined>) {
    return this.request<ApiList<T>>(path, { page, limit: 100, ...params })
  }

  // Follow pagination until exhausted, aggregating all items.
  private async listAll<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T[]> {
    const all: T[] = []
    let page = 1
    while (page <= MAX_PAGES) {
      const res = await this.listPage<T>(path, page, params)
      all.push(...res.data)
      if (!res.pagination?.next) break
      page += 1
    }
    return all
  }

  // ---- Token validation -------------------------------------------------

  // Lightweight call used by onboarding to verify a token works.
  async validateToken(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.request<ApiList<Server>>("/servers", { limit: 1 })
      return { ok: true }
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, reason: err.message }
      return { ok: false, reason: (err as Error).message }
    }
  }

  // ---- Servers ----------------------------------------------------------

  listServers(): Promise<Server[]> {
    return this.listAll<Server>("/servers")
  }

  async getServer(id: number): Promise<Server> {
    const res = await this.request<ApiSingle<Server>>(`/servers/${id}`)
    return res.data
  }

  // The catalog of sizes + regions (with pricing) a provider offers. Provider is
  // a key the API recognizes: digitalocean | vultr | linode | hetzner. The
  // endpoint may or may not be data-wrapped, so normalize defensively.
  async providerMetadata(provider: string): Promise<ProviderMetadata> {
    const raw = await this.request<Record<string, unknown>>(`/providers/${provider}/metadata`)
    const data = raw && typeof raw === "object" && "data" in raw ? (raw.data as Record<string, unknown>) : raw
    return data as unknown as ProviderMetadata
  }

  // Provision a managed server. Async on SpinupWP's side: returns an event_id to
  // poll via getEvent() (provisioning averages ~10 min). Needs a Read/Write token.
  createServer(payload: CreateServerPayload): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>("/servers", "POST", payload)
  }

  // ---- Sites ------------------------------------------------------------

  listSites(serverId?: number): Promise<Site[]> {
    return this.listAll<Site>("/sites", serverId ? { server_id: serverId } : undefined)
  }

  async getSite(id: number): Promise<Site> {
    const res = await this.request<ApiSingle<Site>>(`/sites/${id}`)
    return res.data
  }

  // Create a site. Async on SpinupWP's side: returns an event_id to poll via
  // getEvent(). Needs a Read/Write token. HTTPS is enabled separately — see
  // enableHttps().
  createSite(payload: CreateSitePayload): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>("/sites", "POST", payload)
  }

  // Additional domains on a site (the extra hostnames nginx answers for). The
  // clone wizard re-creates the source's set on the dest — a fresh site only
  // serves its primary domain otherwise.
  async listSiteDomains(siteId: number): Promise<AdditionalDomain[]> {
    return this.listAll<AdditionalDomain>(`/sites/${siteId}/domains`)
  }

  // Add an additional domain to a site. Async (nginx reconfig) → returns an
  // event_id to poll. Needs a Read/Write token.
  addSiteDomain(siteId: number, payload: AddDomainPayload): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>(`/sites/${siteId}/domains`, "POST", payload)
  }

  // Enable HTTPS on a site. `type: "webroot"` requests a Let's Encrypt cert (the
  // domain must already resolve to the server for LE to issue, so this runs after
  // the DNS A record has propagated). Async → returns an event_id to poll. Needs a
  // Read/Write token.
  enableHttps(siteId: number): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>(`/sites/${siteId}/https`, "POST", { type: "webroot" })
  }

  // Disable HTTPS on a site (removes the certificate). May return an event_id to
  // poll, or settle synchronously (204 → undefined) — the store handles both.
  // Needs a Read/Write token.
  disableHttps(siteId: number): Promise<{ event_id: number } | undefined> {
    return this.mutate<{ event_id: number } | undefined>(`/sites/${siteId}/https`, "DELETE")
  }

  // Purge a site's page cache / WordPress object cache. There's no enable/disable
  // for either on an existing site (only at site-creation time) — purge is the
  // only available write. Async → returns an event_id to poll. Needs a Read/Write
  // token.
  purgePageCache(siteId: number): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>(`/sites/${siteId}/page-cache/purge`, "POST")
  }
  purgeObjectCache(siteId: number): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>(`/sites/${siteId}/object-cache/purge`, "POST")
  }

  // ---- Events -----------------------------------------------------------

  // Events can be numerous; cap to the most recent few pages for the feed.
  async listEvents(maxPages = 3): Promise<Event[]> {
    const all: Event[] = []
    let page = 1
    while (page <= maxPages) {
      const res = await this.listPage<Event>("/events", page)
      all.push(...res.data)
      if (!res.pagination?.next) break
      page += 1
    }
    return all
  }

  // Fetch a single event by id — used to track an async write to completion.
  async getEvent(id: number): Promise<Event> {
    const res = await this.request<ApiSingle<Event>>(`/events/${id}`)
    return res.data
  }

  // ---- Writes -----------------------------------------------------------

  // Change a site's PHP version. Async on SpinupWP's side: returns an event_id
  // to poll via getEvent(). SpinupWP installs the version on the server first if
  // it isn't already present. Needs a Read/Write token (see mutate()).
  upgradeSitePhp(siteId: number, phpVersion: string): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>(`/sites/${siteId}/php`, "PUT", { php_version: phpVersion })
  }

  // Reboot a server. Async → returns an event_id to poll via getEvent().
  rebootServer(serverId: number): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>(`/servers/${serverId}/reboot`, "POST")
  }

  // Restart a single service on a server (nginx / php / mysql / redis). Async →
  // returns an event_id to poll via getEvent().
  restartService(serverId: number, service: ServerService): Promise<{ event_id: number }> {
    return this.mutate<{ event_id: number }>(`/servers/${serverId}/services/${service}/restart`, "POST")
  }
}

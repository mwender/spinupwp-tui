// Thin typed wrapper around the SpinupWP REST API using fetch + Bearer auth.
// Read-only by design for now (the configured token has read-only scope).

import type { ApiList, ApiSingle, Server, Site, Event } from "./types.ts"

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

const MAX_PAGES = 100 // hard safety cap when auto-paginating

export class SpinupWPClient {
  private token: string
  private baseUrl: string

  constructor(opts: ClientOptions) {
    this.token = opts.token
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
  }

  private async request<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
      }
    }

    let res: Response
    try {
      res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": "spinupwp-tui",
        },
      })
    } catch (err) {
      throw new ApiError(
        `Network error reaching the SpinupWP API: ${(err as Error).message}`,
        0,
      )
    }

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

  // ---- Sites ------------------------------------------------------------

  listSites(serverId?: number): Promise<Site[]> {
    return this.listAll<Site>("/sites", serverId ? { server_id: serverId } : undefined)
  }

  async getSite(id: number): Promise<Site> {
    const res = await this.request<ApiSingle<Site>>(`/sites/${id}`)
    return res.data
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
}

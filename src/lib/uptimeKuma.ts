// Thin Uptime Kuma client over its socket.io management API (Kuma exposes no REST
// for management — only the push/badge/status-page endpoints). Event names and
// payloads verified against the Kuma 2.x source; everything used here exists in
// 1.21+ as well. Connections are short-lived: connect → login → work → disconnect.
//
// Auth: password login returns a JWT; we hand it back so callers can persist it
// (config.json, 0600) and reconnect via loginByToken — the JWT stays valid until
// the Kuma password changes, and it's what lets a 2FA-protected account work
// beyond its first (token-prompted) login.

import { io, type Socket } from "socket.io-client"

export interface KumaCreds {
  url: string
  username: string
  password: string
  jwt?: string // from a prior successful login; preferred when present
}

// A monitor row as Kuma broadcasts it (monitorList / getMonitor). Only the fields
// we read are typed; the rest ride along untyped.
export interface KumaMonitor {
  id: number
  name: string
  type: string
  url?: string
  active?: boolean | number
  pushToken?: string
  [k: string]: unknown
}

export interface KumaBeat {
  status: number // 0 down, 1 up, 2 pending, 3 maintenance
  time: string
  msg?: string
  ping?: number | null
}

interface Ack {
  ok: boolean
  msg?: string
  monitorID?: number
  maintenanceID?: number
  token?: string
  tokenRequired?: boolean
  data?: unknown
}

const ACK_TIMEOUT_MS = 15_000
const CONNECT_TIMEOUT_MS = 10_000

// 32 chars, [A-Za-z0-9] — same shape the Kuma UI generates for push monitors.
// (Kuma stores whatever the client sends; the token is chosen client-side.)
export function genPushToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return [...bytes].map((b) => chars[b % chars.length]).join("")
}

export function pushUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/push/${token}`
}

export class KumaError extends Error {}

export class KumaClient {
  private socket: Socket
  version: string | null = null
  // Kuma pushes these as events (not ack payloads) right after login and on change.
  private monitorList: Record<string, KumaMonitor> | null = null
  private notificationList: { id: number; isDefault?: boolean; active?: boolean; config?: string }[] = []

  private constructor(socket: Socket) {
    this.socket = socket
    socket.on("info", (info: { version?: string }) => {
      this.version = info?.version ?? null
    })
    socket.on("monitorList", (list: Record<string, KumaMonitor>) => {
      this.monitorList = list
    })
    socket.on("notificationList", (list: typeof this.notificationList) => {
      this.notificationList = list ?? []
    })
  }

  static async connect(url: string): Promise<KumaClient> {
    const base = url.replace(/\/+$/, "")
    const socket = io(base, { transports: ["websocket"], reconnection: false, timeout: CONNECT_TIMEOUT_MS })
    const client = new KumaClient(socket)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        socket.disconnect()
        reject(new KumaError(`Timed out reaching ${base} — is that the right URL?`))
      }, CONNECT_TIMEOUT_MS)
      socket.once("connect", () => {
        clearTimeout(t)
        resolve()
      })
      socket.once("connect_error", (e: Error) => {
        clearTimeout(t)
        socket.disconnect()
        reject(new KumaError(`Couldn't reach Uptime Kuma at ${base}: ${e.message}`))
      })
    })
    return client
  }

  disconnect(): void {
    this.socket.disconnect()
  }

  private emitAck(event: string, ...args: unknown[]): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new KumaError(`Kuma didn't answer "${event}" in time.`)), ACK_TIMEOUT_MS)
      this.socket.emit(event, ...args, (res: Ack) => {
        clearTimeout(t)
        resolve(res ?? { ok: false, msg: "Empty response" })
      })
    })
  }

  private async must(event: string, ...args: unknown[]): Promise<Ack> {
    const res = await this.emitAck(event, ...args)
    if (!res.ok) throw new KumaError(res.msg || `Kuma rejected "${event}".`)
    return res
  }

  // Login, preferring a saved JWT. Returns the JWT to persist on success (the
  // password path mints one; the JWT path echoes it back). `tokenRequired` means
  // the account has 2FA — retry with a current TOTP in `twofa`.
  async login(creds: KumaCreds, twofa?: string): Promise<{ ok: true; jwt: string } | { ok: false; error: string; tokenRequired?: boolean }> {
    if (creds.jwt) {
      const byToken = await this.emitAck("loginByToken", creds.jwt)
      if (byToken.ok) return { ok: true, jwt: creds.jwt }
      // Stale JWT (password changed / server reset) — fall through to password.
    }
    const res = await this.emitAck("login", { username: creds.username, password: creds.password, token: twofa ?? "" })
    if (res.ok && res.token) return { ok: true, jwt: res.token }
    if (res.tokenRequired) return { ok: false, error: "This account has 2FA — enter a current code to log in.", tokenRequired: true }
    return { ok: false, error: res.msg || "Uptime Kuma rejected the login." }
  }

  // The monitor list arrives as a broadcast event (login triggers one); asking via
  // getMonitorList re-triggers it. Await whichever lands first.
  async getMonitors(): Promise<KumaMonitor[]> {
    if (!this.monitorList) {
      const wait = new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new KumaError("Kuma didn't send the monitor list in time.")), ACK_TIMEOUT_MS)
        this.socket.once("monitorList", () => {
          clearTimeout(t)
          resolve()
        })
      })
      await this.emitAck("getMonitorList")
      if (!this.monitorList) await wait
    }
    return Object.values(this.monitorList ?? {})
  }

  // Notifications flagged "Default enabled" in Kuma — the UI auto-attaches these
  // to new monitors, so we do the same for monitors we create.
  private defaultNotificationIds(): Record<string, boolean> {
    const ids: Record<string, boolean> = {}
    for (const n of this.notificationList) {
      try {
        const cfg = n.config ? (JSON.parse(n.config) as { isDefault?: boolean }) : {}
        if (n.isDefault || cfg.isDefault) ids[String(n.id)] = true
      } catch {
        // Unparseable config — skip.
      }
    }
    return ids
  }

  // Kuma 2.x monitors carry a `conditions` array its UI always sends; 1.x has no
  // such column and the insert fails if we send one. Try the 2.x shape first and
  // fall back, so one client speaks to either generation.
  async addMonitor(monitor: Record<string, unknown>): Promise<number> {
    const payload = { notificationIDList: this.defaultNotificationIds(), conditions: [], ...monitor }
    let res = await this.emitAck("add", payload)
    if (!res.ok && /conditions/i.test(res.msg ?? "")) {
      const { conditions: _legacy, ...withoutConditions } = payload
      res = await this.emitAck("add", withoutConditions)
    }
    if (!res.ok) throw new KumaError(res.msg || 'Kuma rejected "add".')
    if (typeof res.monitorID !== "number") throw new KumaError("Kuma didn't return the new monitor's id.")
    return res.monitorID
  }

  async pauseMonitor(id: number): Promise<void> {
    await this.must("pauseMonitor", id)
  }

  async resumeMonitor(id: number): Promise<void> {
    await this.must("resumeMonitor", id)
  }

  async deleteMonitor(id: number): Promise<void> {
    await this.must("deleteMonitor", id)
  }

  async getMonitorBeats(id: number, periodHours: number): Promise<KumaBeat[]> {
    const res = await this.must("getMonitorBeats", id, periodHours)
    return (res.data as KumaBeat[]) ?? []
  }

  // Manual-strategy maintenance: active immediately, until deleted/paused.
  async addManualMaintenance(title: string, description: string): Promise<number> {
    const res = await this.must("addMaintenance", {
      title,
      description,
      strategy: "manual",
      active: true,
      intervalDay: 1,
      dateRange: [null, null],
      timeRange: [
        { hours: 0, minutes: 0 },
        { hours: 0, minutes: 0 },
      ],
      weekdays: [],
      daysOfMonth: [],
    })
    if (typeof res.maintenanceID !== "number") throw new KumaError("Kuma didn't return the maintenance id.")
    return res.maintenanceID
  }

  async setMaintenanceMonitors(maintenanceID: number, monitorIds: number[]): Promise<void> {
    await this.must(
      "addMonitorMaintenance",
      maintenanceID,
      monitorIds.map((id) => ({ id })),
    )
  }

  async deleteMaintenance(maintenanceID: number): Promise<void> {
    await this.must("deleteMaintenance", maintenanceID)
  }
}

// Standard payloads for the two monitors Spinup creates per vanity site. Kuma's
// `add` handler tolerates missing columns, but we send what its own UI sends so
// the rows are indistinguishable from hand-made ones.
export function healthMonitorPayload(name: string, url: string): Record<string, unknown> {
  return {
    type: "http",
    name,
    url,
    method: "GET",
    interval: 60,
    retryInterval: 60,
    resendInterval: 0,
    maxretries: 2, // ride out a brief load spike before alerting
    timeout: 48,
    accepted_statuscodes: ["200-299"],
    expiryNotification: true, // LE-renewal canary for the whole server
    ignoreTls: false,
    upsideDown: false,
    maxredirects: 10,
  }
}

export function loadPushMonitorPayload(name: string, pushToken: string): Record<string, unknown> {
  return {
    type: "push",
    name,
    pushToken,
    // The cron beats once a minute; alert after ~2 missed beats.
    interval: 60,
    retryInterval: 60,
    maxretries: 2,
    upsideDown: false,
    // Kuma validates status-code arrays on every monitor type, push included.
    accepted_statuscodes: ["200-299"],
  }
}

// Connect → login → run → always disconnect. Returns the (possibly refreshed) JWT
// alongside the result so callers can persist it.
export async function withKuma<T>(creds: KumaCreds, fn: (kuma: KumaClient) => Promise<T>): Promise<{ result: T; jwt: string; version: string | null }> {
  const kuma = await KumaClient.connect(creds.url)
  try {
    const login = await kuma.login(creds)
    if (!login.ok) throw new KumaError(login.error)
    const result = await fn(kuma)
    return { result, jwt: login.jwt, version: kuma.version }
  } finally {
    kuma.disconnect()
  }
}

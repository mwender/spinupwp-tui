import { describe, expect, test } from "bun:test"
import { describeConnectError, fatalPushMonitorPayload, registerMonitors, type KumaClient, type KumaMonitor } from "./uptimeKuma.ts"

// Shapes recorded from socket.io-client 4.8 under Bun (#75).
function transportError(message: string, description: unknown) {
  return Object.assign(new Error(message), { type: "TransportError", description })
}

describe("describeConnectError", () => {
  test("a WebSocket failure shows Bun's reason, not 'websocket error'", () => {
    const e = transportError("websocket error", {
      type: "error",
      message: "WebSocket connection to 'wss://kuma.example.com/socket.io/?EIO=4&transport=websocket' failed: Expected 101 status code",
    })
    expect(describeConnectError(e)).toBe("Expected 101 status code")
  })
  test("a TLS failure is named", () => {
    const e = transportError("websocket error", {
      message: "WebSocket connection to 'wss://kuma.example.com/socket.io/?EIO=4&transport=websocket' failed: TLS handshake failed",
    })
    expect(describeConnectError(e)).toBe("TLS handshake failed")
  })
  test("a polling failure shows the HTTP status", () => {
    expect(describeConnectError(transportError("xhr poll error", 404))).toBe("HTTP 404")
  })
  test("a polling failure with no answer says so", () => {
    expect(describeConnectError(transportError("xhr poll error", 0))).toBe("no response")
  })
  test("a bare Error falls back to its message", () => {
    expect(describeConnectError(new Error("boom"))).toBe("boom")
  })
  test("an empty Error falls back to its code", () => {
    expect(describeConnectError(Object.assign(new Error(""), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED")
  })
})

// Just the calls registerMonitors makes, over an in-memory monitor list.
function fakeKuma(initial: KumaMonitor[] = []) {
  const monitors = new Map(initial.map((m) => [m.id, { ...m }]))
  const edits: KumaMonitor[] = []
  let next = 100
  const kuma = {
    getMonitors: async () => [...monitors.values()],
    getMonitor: async (id: number) => ({ ...monitors.get(id)! }),
    editMonitor: async (m: KumaMonitor) => {
      edits.push(m)
      monitors.set(m.id, m)
    },
    addMonitor: async (payload: Record<string, unknown>) => {
      const id = next++
      monitors.set(id, { ...(payload as KumaMonitor), id })
      return id
    },
  }
  return { kuma: kuma as unknown as KumaClient, monitors, edits }
}

describe("registerMonitors health check window", () => {
  const base = { proto: "https" as const, healthzPath: "/", wantPush: false }

  test("a new health monitor gets the chosen window", async () => {
    const { kuma, monitors } = fakeKuma()
    const r = await registerMonitors(kuma, "example.com", { ...base, healthInterval: 300 })
    expect(monitors.get(r.healthId)!.interval).toBe(300)
    expect(monitors.get(r.healthId)!.retryInterval).toBe(60)
    expect(r.healthInterval).toBe(300)
  })

  test("defaults to 60s", async () => {
    const { kuma, monitors } = fakeKuma()
    const r = await registerMonitors(kuma, "example.com", base)
    expect(monitors.get(r.healthId)!.interval).toBe(60)
  })

  test("a repair leaves an existing monitor's window alone", async () => {
    const { kuma, edits } = fakeKuma([{ id: 7, name: "example.com", type: "http", interval: 180 }])
    const r = await registerMonitors(kuma, "example.com", { ...base, healthInterval: 300, known: { healthId: 7 } })
    expect(r.healthId).toBe(7)
    expect(r.healthInterval).toBeUndefined()
    expect(edits).toHaveLength(0)
  })

  test("a picked window retimes the existing monitor in place", async () => {
    const { kuma, monitors, edits } = fakeKuma([{ id: 7, name: "example.com", type: "http", interval: 60, notificationIDList: { 1: true } }])
    const r = await registerMonitors(kuma, "example.com", { ...base, healthInterval: 300, retimeHealth: true, known: { healthId: 7 } })
    expect(r.healthId).toBe(7)
    expect(r.healthInterval).toBe(300)
    expect(edits).toHaveLength(1)
    expect(monitors.get(7)!.interval).toBe(300)
    expect(monitors.get(7)!.notificationIDList).toEqual({ 1: true })
  })
})

describe("fatalPushMonitorPayload", () => {
  // The cron beats every 60 s; a 60 s window raced Kuma's own check and paged on
  // beats that were only late.
  test("gives the minute cron a two-minute window, and keeps two retries", () => {
    const p = fatalPushMonitorPayload("web1.example.com php-fatal", "tok")
    expect(p).toMatchObject({ type: "push", interval: 120, retryInterval: 60, maxretries: 2 })
  })
})

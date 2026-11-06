import { describe, expect, test } from "bun:test"
import { describeConnectError } from "./uptimeKuma.ts"

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

import { describe, expect, test } from "bun:test"
import { isRecheckDue, isVersionOld, VERSION_MAX_AGE_MS, type CachedProbe } from "./stackCache.ts"

const NOW = 1_800_000_000_000

function entry(version: string | null, ageMs: number): CachedProbe {
  return {
    result: { kind: version ? "wordpress" : "whmcs", app: "x", version, label: "x" },
    detectedAt: NOW - ageMs,
    signature: "true:",
  }
}

describe("isVersionOld", () => {
  test("a fresh version reading isn't old", () => {
    expect(isVersionOld(entry("7.1.3", 60_000), NOW)).toBe(false)
  })
  test("a version reading past the max age is old", () => {
    expect(isVersionOld(entry("7.0", VERSION_MAX_AGE_MS + 1), NOW)).toBe(true)
  })
  test("an identity without a version never goes old", () => {
    expect(isVersionOld(entry(null, 365 * VERSION_MAX_AGE_MS), NOW)).toBe(false)
  })
  test("no entry isn't old", () => {
    expect(isVersionOld(undefined, NOW)).toBe(false)
  })
})

describe("isRecheckDue", () => {
  const old = entry("7.0", 3 * VERSION_MAX_AGE_MS)
  test("an old version with no attempt yet is due", () => {
    expect(isRecheckDue(old, NOW)).toBe(true)
  })
  test("an attempt inside the window (even a failed one) holds it off", () => {
    expect(isRecheckDue({ ...old, recheckedAt: NOW - 60_000 }, NOW)).toBe(false)
  })
  test("an attempt from a previous window doesn't", () => {
    expect(isRecheckDue({ ...old, recheckedAt: NOW - VERSION_MAX_AGE_MS - 1 }, NOW)).toBe(true)
  })
  test("a fresh reading is never due", () => {
    expect(isRecheckDue(entry("7.1.3", 60_000), NOW)).toBe(false)
  })
})

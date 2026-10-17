import { expect, test } from "bun:test"
import { isNewer } from "./appUpdate.ts"

test("plain versions", () => {
  expect(isNewer("1.2.0", "1.1.2")).toBe(true)
  expect(isNewer("1.1.2", "1.2.0")).toBe(false)
  expect(isNewer("1.10.0", "1.9.9")).toBe(true)
  expect(isNewer("1.2.0", "1.2.0")).toBe(false)
})

test("a release outranks its pre-releases", () => {
  expect(isNewer("1.2.0", "1.2.0-alpha.1")).toBe(true)
  expect(isNewer("1.2.0-alpha.1", "1.2.0")).toBe(false)
  expect(isNewer("1.2.0-alpha.1", "1.1.2")).toBe(true)
})

test("pre-release ordering", () => {
  expect(isNewer("1.2.0-alpha.2", "1.2.0-alpha.1")).toBe(true)
  expect(isNewer("1.2.0-alpha.10", "1.2.0-alpha.9")).toBe(true)
  expect(isNewer("1.2.0-beta.1", "1.2.0-alpha.5")).toBe(true)
  expect(isNewer("1.2.0-alpha.1", "1.2.0-alpha")).toBe(true)
})

test("unparseable never nags", () => {
  expect(isNewer("garbage", "1.0.0")).toBe(false)
})

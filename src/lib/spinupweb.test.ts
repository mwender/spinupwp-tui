import { describe, expect, test } from "bun:test"
import { parseAccountSlug, siteWebUrl } from "./spinupweb.ts"

describe("parseAccountSlug", () => {
  test("a bare slug", () => {
    expect(parseAccountSlug("  acme-agency ")).toBe("acme-agency")
  })
  test("a whole dashboard URL", () => {
    expect(parseAccountSlug("https://spinupwp.app/acme-agency/sites/123#git")).toBe("acme-agency")
    expect(parseAccountSlug("spinupwp.app/acme-agency")).toBe("acme-agency")
    expect(parseAccountSlug("https://SpinupWP.app/acme-agency/?tab=servers")).toBe("acme-agency")
  })
  test("anything that isn't a slug", () => {
    expect(parseAccountSlug("")).toBeNull()
    expect(parseAccountSlug("https://spinupwp.app/")).toBeNull()
    expect(parseAccountSlug("acme agency")).toBeNull()
    expect(parseAccountSlug("../etc")).toBeNull()
  })
  test("feeds the deep link", () => {
    expect(siteWebUrl(42, parseAccountSlug("https://spinupwp.app/acme-agency/sites"))).toBe("https://spinupwp.app/acme-agency/sites/42")
  })
})

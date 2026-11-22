import { describe, expect, test } from "bun:test"
import { parsePath, render, samplePath, type RenderResult } from "./templates.ts"

const ok = (r: RenderResult) => {
  if (!r.ok) throw new Error(r.message)
  return r.rendered
}
const refused = (r: RenderResult) => {
  expect(r.ok).toBe(false)
  return r.ok ? "" : r.message
}

describe("deny-paths", () => {
  test("a real fix from the ledger renders as expected", () => {
    const r = ok(render({ template: "deny-paths", params: { paths: ["^~ /actuator/", "^~ /manage/", "^~ /telescope/", "^~ /phpmyadmin", "= /pma", "^~ /api/", "= /v2/_catalog", "~ ^/\\.env"], status: 403 } }))
    expect(r.lines).toEqual([
      "location ^~ /actuator/ { return 403; }",
      "location ^~ /manage/ { return 403; }",
      "location ^~ /telescope/ { return 403; }",
      "location ^~ /phpmyadmin { return 403; }",
      "location = /pma { return 403; }",
      "location ^~ /api/ { return 403; }",
      "location = /v2/_catalog { return 403; }",
      "location ~ ^/\\.env { return 403; }",
    ])
    expect(r.checks.map((c) => c.path)).toEqual(["/actuator/samurai-check", "/manage/samurai-check", "/telescope/samurai-check", "/phpmyadmin", "/pma", "/api/samurai-check", "/v2/_catalog", "/.env", "/"])
    expect(r.checks.at(-1)).toMatchObject({ expect: "same-as-before" })
    expect(r.notes).toEqual([])
  })
  test("a plain prefix becomes ^~ so PHP files under it are caught too", () => {
    expect(ok(render({ template: "deny-paths", params: { paths: ["/vendor/"] } })).lines).toEqual(["location ^~ /vendor/ { return 403; }"])
  })
  test("444 is checked as a refused connection", () => {
    expect(ok(render({ template: "deny-paths", params: { paths: ["= /pma"], status: 444 } })).checks[0]).toMatchObject({ expect: "refused" })
  })
  test("duplicates are rendered once", () => {
    expect(ok(render({ template: "deny-paths", params: { paths: ["= /pma", "=/pma"] } })).lines).toHaveLength(1)
  })
  test("a pattern with alternatives is applied but noted as unverifiable", () => {
    const r = ok(render({ template: "deny-paths", params: { paths: ["~ ^/(adminer|pma)\\.php$"] } }))
    expect(r.checks).toHaveLength(1)
    expect(r.notes[0]).toContain("can't be checked")
  })
})

describe("hostile parameters are refused", () => {
  const deny = (paths: unknown, status?: unknown) => render({ template: "deny-paths", params: { paths, ...(status !== undefined ? { status } : {}) } })
  test("anything that catches pages WordPress needs", () => {
    expect(refused(deny(["^~ /"]))).toContain("whole site")
    expect(refused(deny(["~ .*"]))).toContain("would also catch /")
    expect(refused(deny(["~ \\.php$"]))).toContain("/index.php")
    expect(refused(deny(["^~ /wp-"]))).toContain("/wp-login.php")
    expect(refused(deny(["~* ^/WP-ADMIN"]))).toContain("/wp-admin/")
    expect(refused(deny(["^~ /wp-content/"]))).toContain("/wp-content/")
    expect(refused(deny(["= /xmlrpc.php"]))).toContain("/xmlrpc.php")
    expect(refused(deny(["~ sitemap"]))).toContain("sitemap")
  })
  test("nginx syntax smuggled into a path", () => {
    expect(refused(deny(["= /a; return 200"]))).toBeTruthy()
    expect(refused(deny(["= /a{"]))).toBeTruthy()
    expect(refused(deny(["~ ^/a{2}"]))).toBeTruthy()
    expect(refused(deny(["= /a\nlocation / { return 200; }"]))).toBeTruthy()
    expect(refused(deny(['~ "^/a"']))).toBeTruthy()
    expect(refused(deny(["= /a/../b"]))).toBeTruthy()
    expect(refused(deny(["= a"]))).toBeTruthy()
    expect(refused(deny(["~ (?i)/a"]))).toBeTruthy()
  })
  test("bad shapes", () => {
    expect(refused(deny([]))).toContain("1 to 20")
    expect(refused(deny(Array.from({ length: 21 }, (_, i) => `= /p${i}`)))).toContain("1 to 20")
    expect(refused(deny("= /pma"))).toBeTruthy()
    expect(refused(deny([42]))).toBeTruthy()
    expect(refused(deny(["= /pma"], 200))).toContain("status")
    expect(refused(deny(["= /pma"], 410))).toContain("status")
  })
  test("an unknown template", () => {
    expect(refused(render({ template: "raw-nginx", params: {} }))).toContain("no template")
  })
})

describe("gone-paths", () => {
  test("returns 410 and checks it", () => {
    const r = ok(render({ template: "gone-paths", params: { paths: ["^~ /events/list/"] } }))
    expect(r.lines).toEqual(["location ^~ /events/list/ { return 410; }"])
    expect(r.checks[0]).toMatchObject({ path: "/events/list/samurai-check", expect: "status", status: 410 })
  })
})

describe("block-user-agent", () => {
  test("renders a case-insensitive match and checks both sides", () => {
    const r = ok(render({ template: "block-user-agent", params: { pattern: "ShapBot" } }))
    expect(r.lines).toEqual(['if ($http_user_agent ~* "ShapBot") { return 403; }'])
    expect(r.checks[0]).toMatchObject({ userAgent: "ShapBot/1.0", expect: "status", status: 403 })
    expect(r.checks[1]).toMatchObject({ expect: "same-as-before" })
  })
  test("refuses anything that catches a good bot, a monitor or a browser", () => {
    for (const p of ["bot", "Googlebot", "google", "bingbot", "Mozilla", "Chrome", "Safari", "Uptime", "facebook", "WordPress", "compatible", "Apple"]) {
      expect(refused(render({ template: "block-user-agent", params: { pattern: p } }))).toContain("would also block")
    }
  })
  test("refuses quotes, semicolons, braces and tiny patterns", () => {
    for (const p of ['Bad"Bot', "BadBot;", "Bad{Bot}", "ab", "x".repeat(81), "Bad\nBot"]) expect(render({ template: "block-user-agent", params: { pattern: p } }).ok).toBe(false)
  })
  test("444 means the check expects a refused connection", () => {
    expect(ok(render({ template: "block-user-agent", params: { pattern: "Jaunt", status: 444 } })).checks[0]).toMatchObject({ expect: "refused" })
  })
})

describe("cloudflare-real-ip", () => {
  const ranges = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "2400:cb00::/32"]
  test("renders the ranges and the header, dated", () => {
    const r = ok(render({ template: "cloudflare-real-ip", params: {} }, { cloudflareRanges: ranges, today: "2026-11-22" }))
    expect(r.lines[0]).toContain("2026-11-22")
    expect(r.lines).toContain("set_real_ip_from 2400:cb00::/32;")
    expect(r.lines.at(-1)).toBe("real_ip_header CF-Connecting-IP;")
  })
  test("refuses without ranges, with too few, or with junk", () => {
    expect(render({ template: "cloudflare-real-ip", params: {} }).ok).toBe(false)
    expect(render({ template: "cloudflare-real-ip", params: {} }, { cloudflareRanges: ranges.slice(0, 2) }).ok).toBe(false)
    expect(render({ template: "cloudflare-real-ip", params: {} }, { cloudflareRanges: [...ranges, "0.0.0.0/0; allow all"] }).ok).toBe(false)
  })
})

describe("samples", () => {
  test("derived from simple patterns, not from alternatives", () => {
    const s = (p: string) => {
      const r = parsePath(p)
      if (!r.ok) throw new Error(r.message)
      return samplePath(r.rule)
    }
    expect(s("~ ^/\\.git/")).toBe("/.git/")
    expect(s("~* ^/wp-config\\.php\\.bak$")).toBe("/wp-config.php.bak")
    expect(s("~ ^/(a|b)")).toBeNull()
  })
})

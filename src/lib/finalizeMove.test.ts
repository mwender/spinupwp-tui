import { expect, test } from "bun:test"
import type { Site } from "../api/types.ts"
import { dbNameScript, matchFinalizeDestinationSite } from "./finalizeMove.ts"
import { repairDestinationDatabaseScript } from "./serverClone.ts"

function site(id: number, domain: string, additionalDomains: string[] = []): Site {
  return {
    id,
    server_id: 1,
    domain,
    additional_domains: additionalDomains.map((d, i) => ({ id: i + 1, domain: d, created_at: "2026-01-01T00:00:00Z" })),
    site_user: "site",
    php_version: "8.3",
    public_folder: null,
    is_wordpress: true,
    created_at: "2026-01-01T00:00:00Z",
    status: "active",
  }
}

test("finalize matching pairs apex and www variants", () => {
  const dest = site(12, "example.com")
  expect(matchFinalizeDestinationSite("www.example.com", [dest])).toBe(dest)
})

test("finalize matching recognizes a destination additional domain", () => {
  const dest = site(12, "destination.example", ["www.source.example"])
  expect(matchFinalizeDestinationSite("source.example", [dest])).toBe(dest)
})

test("finalize matching refuses ambiguous destination aliases", () => {
  expect(matchFinalizeDestinationSite("example.com", [site(1, "example.com"), site(2, "www.example.com")])).toBeUndefined()
})

test("finalize DB lookup script is valid shell", () => {
  const script = `D=/sites/example/files; cd "$D"; ${dbNameScript("example")}; echo "$DB"`
  const result = Bun.spawnSync(["bash", "-n"], { stdin: new Blob([script]) })
  expect(result.exitCode).toBe(0)
})

test("adopted destination DB repair script is valid shell", () => {
  const script = repairDestinationDatabaseScript("example", "example", "safePassword123")
  const result = Bun.spawnSync(["bash", "-n"], { stdin: new Blob([script]) })
  expect(result.exitCode).toBe(0)
  expect(script).not.toContain(String.fromCharCode(96))
})

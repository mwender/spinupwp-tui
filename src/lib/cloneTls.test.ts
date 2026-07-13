import { expect, test } from "bun:test"
import { activeTlsLookupScript } from "./cloneTls.ts"

test("TLS lookup script is valid shell and safely quotes a domain", () => {
  const script = activeTlsLookupScript("example.com; echo should-not-run")
  const syntax = Bun.spawnSync(["bash", "-n"], { stdin: new Blob([script]) })
  expect(syntax.exitCode).toBe(0)
  expect(script).toContain("DOMAIN='example.com; echo should-not-run'")
})

test("TLS lookup script emits PEM only through labelled stdout fields", () => {
  const script = activeTlsLookupScript("example.com")
  expect(script).toContain('printf "CERT=%s\\nKEY=%s\\nPATH=%s\\n"')
  expect(script).not.toContain("CloneLogger")
})

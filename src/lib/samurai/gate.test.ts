import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { runProcess } from "../schedulerRun.ts"
import { checkGate, GATE_SHA256, GATE_VERSION, gateScriptText, INSTALLER_SHA256, installerText, SERVER_PATHS, sha256 } from "./gate.ts"

describe("the gate SpinupTUI ships", () => {
  // A failure here means a root-owned script changed. Review the change, then
  // update the pin in gate.ts (and GATE_VERSION, if the gate's behaviour did).
  test("the pinned hashes match the scripts", () => {
    expect(sha256(gateScriptText())).toBe(GATE_SHA256)
    expect(sha256(installerText())).toBe(INSTALLER_SHA256)
  })

  test("the gate's own VERSION matches GATE_VERSION", () => {
    expect(gateScriptText()).toContain(`\nVERSION=${GATE_VERSION}\n`)
  })

  test("the paths in gate.ts are the ones the scripts use", () => {
    const g = gateScriptText()
    const i = installerText()
    expect(g).toContain(`\nCONF_ROOT=${SERVER_PATHS.conf}\n`)
    expect(g).toContain(`\nBACKUP_ROOT=${SERVER_PATHS.backups}\n`)
    expect(i).toContain(`\nCONF_ROOT=${SERVER_PATHS.conf}\n`)
    expect(i).toContain(`\nGATE=${SERVER_PATHS.gate}\n`)
    expect(i).toContain(`\nSUDOERS=${SERVER_PATHS.sudoers}\n`)
    expect(i).toContain(`\nDEPLOY_USER=${SERVER_PATHS.user}\n`)
    expect(i).toContain(`\nDEPLOY_HOME=${SERVER_PATHS.home}\n`)
  })

  test("nothing in either script still names the proof of concept", () => {
    for (const text of [gateScriptText(), installerText()]) {
      expect(text).not.toMatch(/spinupwp-nginx-deploy|nginxdeploy/)
    }
  })

  test("install and gate, end to end in a sandbox", async () => {
    const p = await runProcess(["bash", join(import.meta.dir, "server", "sandbox.test.sh")], { cwd: import.meta.dir, env: { ...process.env } as Record<string, string>, timeoutMs: 120_000 })
    if (p.code !== 0) console.log(p.output)
    expect(p.output).toMatch(/\d+ passed, 0 failed/)
    expect(p.code).toBe(0)
  }, 130_000)
})

describe("checkGate", () => {
  test("accepts exactly the shipped gate", () => {
    expect(checkGate({ version: `${GATE_VERSION}\n`, hash: `${GATE_SHA256}\n` })).toEqual({ ok: true })
  })
  test("names what's wrong otherwise", () => {
    expect(checkGate({ version: null, hash: null })).toMatchObject({ ok: false, reason: "missing" })
    expect(checkGate({ version: "1.1.0", hash: GATE_SHA256 })).toMatchObject({ ok: false, reason: "version" })
    expect(checkGate({ version: GATE_VERSION, hash: "0".repeat(64) })).toMatchObject({ ok: false, reason: "hash" })
    expect(checkGate({ version: GATE_VERSION, hash: null })).toMatchObject({ ok: false, reason: "hash" })
  })
})

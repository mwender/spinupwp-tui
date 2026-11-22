import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runProcess } from "../schedulerRun.ts"
import { GATE_SHA256, INSTALLER_SHA256, sha256 } from "./gate.ts"
import { parseServerState, registerScript, SAMURAI_FILE, stateScript } from "./setup.ts"

describe("reading a server's state", () => {
  test("a server with nothing installed", () => {
    const s = parseServerState("==SITEDIR\nyes\n==REALIP\nyes\n==GATEHASH\n==GATEVER\n==REGISTERED\n==ALLOWED\n==KEYS\n==OLDGATE\n==SAMURAI\n")
    expect(s).toEqual({ siteDir: true, realip: true, gate: null, allowed: null, keys: [], oldGateSite: false, samuraiFile: false })
  })
  test("a registered site", () => {
    const s = parseServerState(`==SITEDIR\nyes\n==REALIP\n==GATEHASH\n${GATE_SHA256}\n==GATEVER\n2.0.0\n==REGISTERED\nyes\n==ALLOWED\n# comment\n${SAMURAI_FILE}\nbefore/zz.conf\n==KEYS\nssh-ed25519 AAAA one\nssh-ed25519 BBBB two\n==OLDGATE\n==SAMURAI\nyes\n`)
    expect(s.gate).toEqual({ version: "2.0.0", hash: GATE_SHA256 })
    expect(s.allowed).toEqual([SAMURAI_FILE, "before/zz.conf"])
    expect(s.keys).toHaveLength(2)
    expect(s.realip).toBe(false)
    expect(s.samuraiFile).toBe(true)
  })
  test("the state script only reads", () => {
    const script = stateScript("example.com")
    expect(script).not.toMatch(/\bsudo\b|\brm\b|>\s*\/(?!dev\/null)|\bmv\b|\bcp\b|\btee\b|\binstall\b(?!\.)/)
  })
})

describe("the script sent to sudo", () => {
  // Runs the script with its last step (install.sh) swapped for a copy, and
  // checks every file arrives byte for byte.
  test("delivers exactly the shipped gate and installer, the allowlist and the keys", async () => {
    const out = mkdtempSync(join(tmpdir(), "samurai-bundle-"))
    const script = registerScript("example.com", [SAMURAI_FILE, "before/zz.conf"], ["ssh-ed25519 AAAA one", "ssh-ed25519 BBBB two"])
    const lines = script.split("\n")
    const installLine = lines.findIndex((l) => l.startsWith('bash "$d/install.sh" example.com'))
    expect(installLine).toBeGreaterThan(0)
    lines[installLine] = `cp -R "$d"/. "${out}/"`
    const p = await runProcess(["bash", "-c", lines.join("\n")], { cwd: out, env: { ...process.env } as Record<string, string>, timeoutMs: 30_000 })
    expect(p.code).toBe(0)
    expect(p.output).toContain("__SAMURAI_SETUP_OK__")
    expect(sha256(readFileSync(join(out, "spinuptui-nginx"), "utf8"))).toBe(GATE_SHA256)
    expect(sha256(readFileSync(join(out, "install.sh"), "utf8"))).toBe(INSTALLER_SHA256)
    expect(readFileSync(join(out, "example.com.allowed"), "utf8")).toBe(`${SAMURAI_FILE}\nbefore/zz.conf\n`)
    expect(readFileSync(join(out, "example.com.pub"), "utf8")).toBe("ssh-ed25519 AAAA one\nssh-ed25519 BBBB two\n")
  })
  test("refuses to run a gate that arrived damaged", async () => {
    const script = registerScript("example.com", [SAMURAI_FILE], ["ssh-ed25519 AAAA one"]).replace(/^(base64 -d > "\$d\/spinuptui-nginx" <<'SAMURAI_B64'\n)(.)/m, (_m, a, c) => a + (c === "I" ? "J" : "I"))
    const lines = script.split("\n").map((l) => (l.startsWith('bash "$d/install.sh"') ? "echo SHOULD_NOT_RUN" : l))
    const p = await runProcess(["bash", "-c", lines.join("\n")], { cwd: tmpdir(), env: { ...process.env } as Record<string, string>, timeoutMs: 30_000 })
    expect(p.code).not.toBe(0)
    expect(p.output).not.toContain("SHOULD_NOT_RUN")
  })
})

// Propose, apply and roll back end to end, against the real spinuptui-nginx
// gate script running locally in a sandbox (nginx, systemctl and flock
// mocked), and a fake website that obeys whatever samurai.conf the gate last
// installed.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fold, readLedger, type Todo, type TodoEvent } from "../todos.ts"
import { gateScriptText, sha256 } from "./gate.ts"
import type { GateTarget } from "./remote.ts"
import { applyProposal, listProposals, propose, rollbackProposal, type Fetcher } from "./fix.ts"
import { deployCommitted, keyPath, mirrorDir, SAMURAI_FILE, SAMURAI_HEADER, syncMirror } from "./setup.ts"

const DOMAIN = "example.com"
let root = ""
let siteDir = ""
let target: GateTarget
let proposals = ""
let ledger = ""
const saved = { xdg: process.env.XDG_CONFIG_HOME, home: process.env.SPINUPTUI_HOME }

function sandboxGate(): string {
  const mock = join(root, "mock")
  mkdirSync(mock, { recursive: true })
  writeFileSync(join(mock, "nginx"), `#!/usr/bin/env bash\nif [ -f "${root}/nginx-fails" ] || grep -rqs BROKEN "${root}/sites-available"; then echo "nginx: [emerg] mock failure" >&2; exit 1; fi\necho "nginx: configuration file test is successful" >&2\n`)
  writeFileSync(join(mock, "systemctl"), `#!/usr/bin/env bash\necho "$*" >> "${root}/systemctl.log"\n`)
  writeFileSync(join(mock, "flock"), "#!/bin/sh\nexit 0\n")
  writeFileSync(join(mock, "install"), `#!/usr/bin/env bash\nargs=()\nwhile (( $# )); do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done\nexec /usr/bin/install "\${args[@]}"\n`)
  for (const f of ["nginx", "systemctl", "flock", "install"]) chmodSync(join(mock, f), 0o755)
  const gate = gateScriptText()
    .replace(/^PATH=.*$/m, `PATH=${mock}:/usr/bin:/bin:/usr/sbin:/sbin`)
    .replace(/^SITES_ROOT=.*$/m, `SITES_ROOT=${root}/sites-available`)
    .replace(/^CONF_ROOT=.*$/m, `CONF_ROOT=${root}/conf`)
    .replace(/^BACKUP_ROOT=.*$/m, `BACKUP_ROOT=${root}/backups`)
    .replace(/^LOCK_ROOT=.*$/m, `LOCK_ROOT=${root}`)
    .replace(/^REQUIRE_ROOT=.*$/m, "REQUIRE_ROOT=0")
  const path = join(root, "spinuptui-nginx")
  writeFileSync(path, gate, { mode: 0o755 })
  return path
}

// The site as a visitor sees it: the home page is 200, and samurai.conf's
// rules apply, unless `ignoreRules` pretends they didn't take effect.
function site(opts: { ignoreRules?: boolean; everything?: number } = {}): Fetcher {
  return async (url, init) => {
    const path = new URL(url).pathname
    const ua = String((init.headers as Record<string, string>)["user-agent"] ?? "")
    if (opts.everything) return new Response("", { status: opts.everything })
    const conf = existsSync(join(siteDir, SAMURAI_FILE)) ? readFileSync(join(siteDir, SAMURAI_FILE), "utf8") : ""
    if (!opts.ignoreRules) {
      for (const line of conf.split("\n")) {
        const loc = /^location (=|\^~|~\*|~) (\S+) \{ return (\d+); \}$/.exec(line)
        const ifua = /^if \(\$http_user_agent ~\* "(.+)"\) \{ return (\d+); \}$/.exec(line)
        let hit = false
        let status = 0
        if (loc) {
          const [, mod, v, s] = loc
          hit = mod === "=" ? path === v : mod === "^~" ? path.startsWith(v!) : new RegExp(v!, mod === "~*" ? "i" : "").test(path)
          status = Number(s)
        } else if (ifua) {
          hit = new RegExp(ifua[1]!, "i").test(ua)
          status = Number(ifua[2])
        }
        if (hit) {
          if (status === 444) throw new Error("connection closed")
          return new Response("", { status })
        }
      }
    }
    return new Response("", { status: path === "/" ? 200 : 404 })
  }
}

const todo = (id: string, fix: Todo["fix"], state: Todo["state"] = "open"): Todo => ({ id, kind: "nginx", scope: `site:${DOMAIN}`, title: `Fix ${id}`, fix, state, reports: [], comments: [], history: [], createdAt: "2026-11-22T00:00:00Z", updatedAt: "2026-11-22T00:00:00Z", changedAt: "2026-11-22T00:00:00Z" })
const T1 = () => todo("T-1", { template: "deny-paths", params: { paths: ["= /pma", "^~ /actuator/"], status: 403 } })
const T2 = () => todo("T-2", { template: "block-user-agent", params: { pattern: "ShapBot" } })
const ledgerState = (id: string) => fold(readLedger(ledger).events).get(id)
const created = (f: Todo): TodoEvent => ({ v: 1, at: "2026-11-22T00:00:00Z", by: "sentinel", id: f.id, event: "created", kind: f.kind, scope: f.scope, title: f.title, fix: f.fix })
const pages: string[] = []
const ctx = (fetcher: Fetcher) => ({ target, by: "operator@test", fetcher, dir: proposals, ledgerPath: ledger, page: async (t: string) => void pages.push(t), sleep: async () => {} })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "samurai-fix-"))
  process.env.XDG_CONFIG_HOME = join(root, "config")
  process.env.SPINUPTUI_HOME = join(root, "home")
})
afterAll(() => {
  process.env.XDG_CONFIG_HOME = saved.xdg
  process.env.SPINUPTUI_HOME = saved.home
  if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME
  if (saved.home === undefined) delete process.env.SPINUPTUI_HOME
  rmSync(root, { recursive: true, force: true })
})

// A freshly set-up site before each test: the gate, its allowlist, a key, a
// mirror and an empty samurai.conf deployed, as `samurai setup` leaves it.
beforeEach(async () => {
  for (const d of ["sites-available", "conf", "backups", "config", "home", "proposals"]) rmSync(join(root, d), { recursive: true, force: true })
  rmSync(join(root, "nginx-fails"), { force: true })
  siteDir = join(root, "sites-available", DOMAIN)
  for (const d of ["before", "server", "location", "after"]) mkdirSync(join(siteDir, d), { recursive: true })
  writeFileSync(join(siteDir, "server", "https.conf"), "# managed\n")
  writeFileSync(join(siteDir, DOMAIN), "server { }\n")
  mkdirSync(join(root, "conf", "sites"), { recursive: true })
  writeFileSync(join(root, "conf", "sites", `${DOMAIN}.allowed`), `${SAMURAI_FILE}\n`)
  const gate = sandboxGate()
  target = { ip: "203.0.113.1", port: null, keyPath: "/dev/null", command: ["bash", gate, DOMAIN], gateSha256: sha256(readFileSync(gate, "utf8")) }
  proposals = join(root, "proposals")
  ledger = join(root, "home", "todos.jsonl")
  mkdirSync(join(root, "home"), { recursive: true })
  writeFileSync(ledger, [T1(), T2()].map((f) => JSON.stringify(created(f))).join("\n") + "\n")
  mkdirSync(join(root, "config", "spinupwp-tui", "modules", "samurai", "keys"), { recursive: true })
  writeFileSync(`${keyPath(DOMAIN)}.pub`, "ssh-ed25519 AAAA test\n")
  const m = await syncMirror(DOMAIN, target)
  expect(m.ok).toBe(true)
  writeFileSync(join(mirrorDir(DOMAIN), SAMURAI_FILE), SAMURAI_HEADER)
  const { spawn } = await import("../spawn.ts")
  for (const args of [["add", SAMURAI_FILE], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "empty"]]) await spawn(["git", "-C", mirrorDir(DOMAIN), ...args], { stdout: "ignore", stderr: "ignore" }).exited
  expect((await deployCommitted(DOMAIN, target, [SAMURAI_FILE])).ok).toBe(true)
  pages.length = 0
})

const serverFile = () => readFileSync(join(siteDir, SAMURAI_FILE), "utf8")

describe("propose", () => {
  test("writes down the rule, the whole new file, a diff and a hash, and changes nothing", async () => {
    const r = await propose({ todo: T1(), target, by: "operator@test", fetcher: site(), dir: proposals })
    if (!r.ok) throw new Error(r.message)
    const p = r.proposal
    expect(p.status).toBe("proposed")
    expect(p.previous).toBe(SAMURAI_HEADER)
    expect(p.file).toContain("# T-1 deny-paths: Fix T-1 (proposal ")
    expect(p.diff).toContain("+ location = /pma { return 403; }")
    expect(p.diff).toContain("+ location ^~ /actuator/ { return 403; }")
    expect(p.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(serverFile()).toBe(SAMURAI_HEADER)
  })
  test("refuses a fix already in effect", async () => {
    const r = await propose({ todo: T1(), target, by: "operator@test", fetcher: site({ everything: 403 }), dir: proposals })
    expect(r).toMatchObject({ ok: false, reason: "already_in_effect" })
  })
  test("refuses when samurai.conf was changed on the server some other way", async () => {
    writeFileSync(join(siteDir, SAMURAI_FILE), SAMURAI_HEADER + "location = /x { return 403; }\n")
    const r = await propose({ todo: T1(), target, by: "operator@test", fetcher: site(), dir: proposals })
    expect(r).toMatchObject({ ok: false, reason: "drift" })
  })
  test("refuses a to-do that isn't open, or whose site isn't set up here", async () => {
    expect(await propose({ todo: { ...T1(), state: "done" }, target, by: "o", fetcher: site(), dir: proposals })).toMatchObject({ ok: false, reason: "not_open" })
    rmSync(`${keyPath(DOMAIN)}.pub`)
    expect(await propose({ todo: T1(), target, by: "o", fetcher: site(), dir: proposals })).toMatchObject({ ok: false, reason: "not_set_up" })
  })
})

describe("apply", () => {
  test("deploys exactly the proposal, verifies it from outside, and closes the to-do", async () => {
    const r = await propose({ todo: T1(), target, by: "operator@test", fetcher: site(), dir: proposals })
    if (!r.ok) throw new Error(r.message)
    const a = await applyProposal(r.proposal.id, r.proposal.hash, T1(), ctx(site()))
    if (!a.ok) throw new Error(a.message)
    expect(serverFile()).toBe(r.proposal.file)
    expect(a.verification.every((v) => v.ok)).toBe(true)
    expect(a.verification.map((v) => v.path)).toEqual(["/pma", "/actuator/samurai-check", "/"])
    expect(a.proposal.status).toBe("applied")
    expect(ledgerState("T-1")?.state).toBe("done")
    expect(ledgerState("T-1")?.history.at(-1)).toMatchObject({ event: "fix-applied", proposal: r.proposal.id })
  })
  test("refuses a hash that isn't the reviewed one", async () => {
    const r = await propose({ todo: T1(), target, by: "o", fetcher: site(), dir: proposals })
    if (!r.ok) throw new Error(r.message)
    expect(await applyProposal(r.proposal.id, "0".repeat(16), T1(), ctx(site()))).toMatchObject({ ok: false, reason: "hash_mismatch" })
    expect(serverFile()).toBe(SAMURAI_HEADER)
  })
  test("two fixes on one site end up in one file; a proposal made before the other was applied is stale", async () => {
    const a = await propose({ todo: T1(), target, by: "o", fetcher: site(), dir: proposals })
    await Bun.sleep(1100) // proposal ids are per second
    const b = await propose({ todo: T2(), target, by: "o", fetcher: site(), dir: proposals })
    if (!a.ok || !b.ok) throw new Error("propose failed")
    expect((await applyProposal(a.proposal.id, a.proposal.hash, T1(), ctx(site()))).ok).toBe(true)
    expect(await applyProposal(b.proposal.id, b.proposal.hash, T2(), ctx(site()))).toMatchObject({ ok: false, reason: "stale" })
    const b2 = await propose({ todo: T2(), target, by: "o", fetcher: site(), dir: proposals })
    if (!b2.ok) throw new Error(b2.message)
    const applied = await applyProposal(b2.proposal.id, b2.proposal.hash, T2(), ctx(site()))
    if (!applied.ok) throw new Error(applied.message)
    expect(serverFile()).toContain("location = /pma { return 403; }")
    expect(serverFile()).toContain('if ($http_user_agent ~* "ShapBot") { return 403; }')
  })
  test("a failed check from outside rolls the change back, records why, and pages", async () => {
    const r = await propose({ todo: T1(), target, by: "o", fetcher: site(), dir: proposals })
    if (!r.ok) throw new Error(r.message)
    const a = await applyProposal(r.proposal.id, r.proposal.hash, T1(), ctx(site({ ignoreRules: true })))
    expect(a).toMatchObject({ ok: false, reason: "verify_failed", rolledBack: true })
    expect(serverFile()).toBe(SAMURAI_HEADER)
    expect(listProposals(proposals)[0]?.status).toBe("failed")
    expect(ledgerState("T-1")?.state).toBe("open")
    expect(ledgerState("T-1")?.comments.at(-1)?.text).toContain("rolled it back")
    expect(pages[0]).toContain("Samurai rolled back T-1")
  })
  test("nginx refusing the change leaves the server and the mirror as they were", async () => {
    const r = await propose({ todo: T1(), target, by: "o", fetcher: site(), dir: proposals })
    if (!r.ok) throw new Error(r.message)
    writeFileSync(join(root, "nginx-fails"), "")
    const a = await applyProposal(r.proposal.id, r.proposal.hash, T1(), ctx(site()))
    expect(a).toMatchObject({ ok: false, reason: "deploy_failed" })
    expect(serverFile()).toBe(SAMURAI_HEADER)
    expect(readFileSync(join(mirrorDir(DOMAIN), SAMURAI_FILE), "utf8")).toBe(SAMURAI_HEADER)
  })
})

describe("rollback", () => {
  test("removes the rule, checks the site, and reopens the to-do", async () => {
    const r = await propose({ todo: T1(), target, by: "o", fetcher: site(), dir: proposals })
    if (!r.ok) throw new Error(r.message)
    expect((await applyProposal(r.proposal.id, r.proposal.hash, T1(), ctx(site()))).ok).toBe(true)
    const b = await rollbackProposal(r.proposal.id, ctx(site()))
    if (!b.ok) throw new Error(b.message)
    expect(serverFile()).toBe(SAMURAI_HEADER)
    expect(b.proposal.status).toBe("rolled-back")
    expect(ledgerState("T-1")?.state).toBe("open")
    expect(await rollbackProposal(r.proposal.id, ctx(site()))).toMatchObject({ ok: false, reason: "not_applied" })
  })
})

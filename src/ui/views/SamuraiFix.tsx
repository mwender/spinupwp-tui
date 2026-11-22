// Apply an nginx to-do's fix with Samurai, or roll one back: f on the to-do in
// the Reports tab (u to roll back one Samurai applied). The work is
// lib/samurai/fix.ts, shared with `spinuptui samurai propose/apply/rollback`.
//
// Applying is two steps on purpose. Opening this proposes: it refreshes the
// site's config, renders the rule, and shows the exact change, the checks
// that will run from outside, and how to undo it. Nothing changes until y,
// which applies exactly that proposal (its hash), then checks the site; a
// failed check puts the previous file back by itself.
//
// Dev Mode never touches a server: it shows a made-up proposal and pretends.

import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { isDevMode } from "../../dev/devMode.ts"
import { loadConfig } from "../../config.ts"
import { beaconFromConfig, beaconSend } from "../../lib/beacon.ts"
import { operator } from "../../lib/todoActions.ts"
import { readLedger, type Todo } from "../../lib/todos.ts"
import { applyProposal, latestProposalFor, propose, rollbackProposal, type CheckResult, type Proposal } from "../../lib/samurai/fix.ts"
import { keyPath, SAMURAI_FILE } from "../../lib/samurai/setup.ts"
import { render } from "../../lib/samurai/templates.ts"
import type { GateTarget } from "../../lib/samurai/remote.ts"
import { reportSource } from "../reportSource.ts"

type Phase =
  | { at: "working"; lines: string[] }
  | { at: "review"; proposal: Proposal; already: CheckResult[] }
  | { at: "confirm-rollback"; proposal: Proposal }
  | { at: "result"; ok: boolean; title: string; message: string; remedy?: string; verification: CheckResult[]; lines: string[] }

const WIDTH = 80

export function SamuraiFix() {
  const { samuraiFix, setSamuraiFix, sites, servers } = useStore()
  const todo = samuraiFix?.todo ?? null
  const mode = samuraiFix?.mode ?? "apply"
  const domain = todo?.scope.startsWith("site:") ? todo.scope.slice(5) : ""
  const site = sites.find((s) => s.domain === domain)
  const server = site ? servers.find((s) => s.id === site.server_id) : undefined
  const [phase, setPhase] = useState<Phase>({ at: "working", lines: [] })
  const live = useRef(true)
  const busy = phase.at === "working"

  const target = (): GateTarget | null => (server?.ip_address ? { ip: server.ip_address, port: server.ssh_port ?? null, keyPath: keyPath(domain) } : null)

  // Runs a step with progress lines, into the "working" phase.
  const withLines = async <T,>(fn: (add: (l: string) => void) => Promise<T>): Promise<{ r: T; lines: string[] }> => {
    const lines: string[] = []
    const add = (l: string) => {
      lines.push(l)
      if (live.current) setPhase({ at: "working", lines: [...lines] })
    }
    setPhase({ at: "working", lines })
    return { r: await fn(add), lines }
  }

  useEffect(() => {
    live.current = true
    if (!todo) return
    void (async () => {
      if (mode === "rollback") {
        const p = isDevMode() ? devProposal(todo, "applied") : latestProposalFor(todo.id)
        if (!p || p.status !== "applied") return setPhase({ at: "result", ok: false, title: " Nothing to roll back ", message: `Samurai hasn't applied a fix for ${todo.id} that's still in place.`, verification: [], lines: [] })
        return setPhase({ at: "confirm-rollback", proposal: p })
      }
      if (isDevMode()) {
        const { lines } = await withLines(async (add) => {
          for (const l of ["Checking the gate", "Refreshing the local copy of the config", `Checking ${domain} from outside, before`]) {
            add(l)
            await new Promise((r) => setTimeout(r, 400))
          }
        })
        void lines
        if (live.current) setPhase({ at: "review", proposal: devProposal(todo, "proposed"), already: [] })
        return
      }
      const t = target()
      if (!t) return setPhase({ at: "result", ok: false, title: " Can't propose ", message: `SpinupTUI can't find ${domain}'s server address.`, verification: [], lines: [] })
      const { r, lines } = await withLines((add) => propose({ todo, target: t, by: operator() }, add))
      if (!live.current) return
      if (r.ok) setPhase({ at: "review", proposal: r.proposal, already: r.alreadyInEffect })
      else setPhase({ at: "result", ok: false, title: " Nothing proposed ", message: r.message, remedy: r.remedy, verification: [], lines })
    })()
    return () => {
      live.current = false
    }
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo?.id, mode])

  const close = () => setSamuraiFix(null)

  const apply = (p: Proposal) => {
    void (async () => {
      if (isDevMode()) {
        const { lines } = await withLines(async (add) => {
          for (const l of ["Checking the gate", "Refreshing the local copy of the config", `Checking ${domain} from outside, before`, `Pushing ${SAMURAI_FILE} through the gate (nginx -t, then reload)`, `Checking ${domain} from outside, after`]) {
            add(l)
            await new Promise((r) => setTimeout(r, 450))
          }
        })
        const verification = p.rendered.checks.map((c) => ({ label: c.label, path: c.path, expected: c.status ? String(c.status) : "as before", got: c.status ? String(c.status) : "200", ok: true }))
        reportSource().record({ v: 1, at: new Date().toISOString(), by: "operator@devmode", id: p.todoId, event: "fix-applied", proposal: p.id, text: `Samurai applied ${p.template} (Dev Mode).` })
        if (live.current) setPhase({ at: "result", ok: true, title: " Applied ", message: `${p.todoId} is fixed and marked done. Every check from outside passed.`, verification, lines })
        return
      }
      const t = target()
      if (!t) return
      const page = async (text: string) => void (await beaconSend(beaconFromConfig(loadConfig()), text))
      const fresh = readLedger().items.get(p.todoId)
      const { r, lines } = await withLines((add) => applyProposal(p.id, p.hash, fresh, { target: t, by: operator(), page }, add))
      if (!live.current) return
      if (r.ok) setPhase({ at: "result", ok: true, title: " Applied ", message: `${p.todoId} is fixed and marked done. Every check from outside passed. Press u on it to roll it back.`, verification: r.verification, lines })
      else setPhase({ at: "result", ok: false, title: r.reason === "verify_failed" ? " Rolled back " : " Not applied ", message: r.message, remedy: r.remedy, verification: r.verification ?? [], lines })
    })()
  }

  const rollback = (p: Proposal) => {
    void (async () => {
      if (isDevMode()) {
        const { lines } = await withLines(async (add) => {
          for (const l of ["Checking the gate", "Refreshing the local copy of the config", `Removing ${p.todoId}'s rule and pushing through the gate`]) {
            add(l)
            await new Promise((r) => setTimeout(r, 450))
          }
        })
        reportSource().record({ v: 1, at: new Date().toISOString(), by: "operator@devmode", id: p.todoId, event: "fix-rolled-back", proposal: p.id, text: "Rolled back (Dev Mode)." })
        if (live.current) setPhase({ at: "result", ok: true, title: " Rolled back ", message: `${p.todoId}'s rule is out and the to-do is open again.`, verification: [{ label: "the home page answers as before", path: "/", expected: "as before (200)", got: "200", ok: true }], lines })
        return
      }
      const t = target()
      if (!t) return
      const { r, lines } = await withLines((add) => rollbackProposal(p.id, { target: t, by: operator() }, add))
      if (!live.current) return
      if (r.ok) setPhase({ at: "result", ok: true, title: " Rolled back ", message: `${p.todoId}'s rule is out and the to-do is open again.`, verification: r.verification, lines })
      else setPhase({ at: "result", ok: false, title: " Not rolled back ", message: r.message, remedy: r.remedy, verification: r.verification ?? [], lines })
    })()
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (busy) return // a push half done is worse than a few seconds' wait
    if (name === "escape" || name === "q") return close()
    if (name !== "y") return
    if (phase.at === "review") apply(phase.proposal)
    else if (phase.at === "confirm-rollback") rollback(phase.proposal)
  })

  if (!todo) return null

  const hints =
    phase.at === "review"
      ? [{ key: "y", label: "apply it" }, { key: "esc", label: "cancel" }]
      : phase.at === "confirm-rollback"
        ? [{ key: "y", label: "roll it back" }, { key: "esc", label: "cancel" }]
        : busy
          ? [{ key: "…", label: "working: this takes under a minute" }]
          : [{ key: "esc", label: "close" }]

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content={`⚔ Samurai  ${todo.id}  `} fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(todo.title, 60)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={truncate(domain, 34)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />
      </box>
      <Centered>{body()}</Centered>
      <StatusBar hints={hints} showGlobal={false} />
    </box>
  )

  function body() {
    if (phase.at === "working") {
      return (
        <Panel title={mode === "rollback" ? " Rolling back " : " Working "} active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            {phase.lines.length === 0 && (
              <box style={{ flexDirection: "row" }}>
                <Spinner />
                <text content=" Starting…" fg={theme.textDim} />
              </box>
            )}
            {phase.lines.map((l, i) => (
              <box key={i} style={{ flexDirection: "row" }}>
                {i === phase.lines.length - 1 ? <box style={{ width: 3, flexShrink: 0 }}><Spinner /></box> : <text content=" ✓ " fg={theme.good} style={{ flexShrink: 0 }} />}
                <text content={l} fg={theme.text} wrapMode="none" />
              </box>
            ))}
          </box>
        </Panel>
      )
    }
    if (phase.at === "review") return review(phase.proposal, phase.already)
    if (phase.at === "confirm-rollback") {
      const p = phase.proposal
      return (
        <Panel title=" Roll back " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <text content={`Take ${p.todoId}'s ${p.template} rule out of ${p.domain}'s ${SAMURAI_FILE}?`} fg={theme.text} />
            <box style={{ height: 1 }} />
            {p.rendered.lines.map((l, i) => (
              <text key={i} content={`- ${l}`} fg={theme.bad} wrapMode="none" />
            ))}
            <box style={{ height: 1 }} />
            <text content={`It goes through the gate like any change (nginx -t, then reload), Samurai checks the home page still answers, and ${p.todoId} opens again.`} fg={theme.textDim} />
            <box style={{ height: 1 }} />
            <text content="Press y to roll it back · Esc to cancel" fg={theme.textFaint} wrapMode="none" />
          </box>
        </Panel>
      )
    }
    return result(phase)
  }

  function review(p: Proposal, already: CheckResult[]) {
    const added = p.diff.split("\n").filter((l) => l.startsWith("+ ") && l.trim() !== "+")
    return (
      <Panel title=" Review the change " active>
        <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`Samurai would add this to ${p.domain}'s ${SAMURAI_FILE}:`} fg={theme.text} />
          <box style={{ height: 1 }} />
          {added.map((l, i) => (
            <text key={i} content={l} fg={l.startsWith("+ #") ? theme.textFaint : theme.good} wrapMode="none" />
          ))}
          <box style={{ height: 1 }} />
          <text content="Then it checks from outside:" fg={theme.text} />
          {p.rendered.checks.map((c, i) => (
            <text key={i} content={`  · ${c.label}`} fg={theme.textDim} wrapMode="none" />
          ))}
          {[...p.rendered.notes, ...already.map((a) => `${a.path} already answers ${a.got}; the rule covers it anyway.`)].map((n, i) => (
            <text key={`n${i}`} content={`Note: ${n}`} fg={theme.warn} />
          ))}
          <box style={{ height: 1 }} />
          <text content="nginx -t runs before the reload, and the gate restores the previous file if it fails. If a check fails, Samurai puts the previous file back and pages you. u on the to-do rolls it back later." fg={theme.textDim} />
          <box style={{ height: 1 }} />
          <text content={`Proposal ${p.id} · press y to apply exactly this · Esc to cancel`} fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function result(r: Extract<Phase, { at: "result" }>) {
    return (
      <Panel title={r.title} active>
        <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
          {r.lines.map((l, i) => (
            <box key={i} style={{ flexDirection: "row" }}>
              <text content={!r.ok && i === r.lines.length - 1 && !r.verification.length ? " ✗ " : " ✓ "} fg={!r.ok && i === r.lines.length - 1 && !r.verification.length ? theme.bad : theme.good} style={{ flexShrink: 0 }} />
              <text content={l} fg={theme.textDim} wrapMode="none" />
            </box>
          ))}
          {r.verification.length > 0 && <box style={{ height: 1 }} />}
          {r.verification.map((v, i) => (
            <box key={`v${i}`} style={{ flexDirection: "row" }}>
              <text content={v.ok ? " ✓ " : " ✗ "} fg={v.ok ? theme.good : theme.bad} style={{ flexShrink: 0 }} />
              <text content={`${v.label} (got ${v.got})`} fg={theme.text} wrapMode="none" />
            </box>
          ))}
          <box style={{ height: 1 }} />
          <text content={r.message} fg={r.ok ? theme.good : theme.bad} />
          {r.remedy && <text content={r.remedy} fg={theme.textDim} />}
        </box>
      </Panel>
    )
  }
}

// ---- Dev Mode -----------------------------------------------------------------

function devProposal(f: Todo, status: Proposal["status"]): Proposal {
  const fix = f.fix ?? { template: "deny-paths", params: { paths: ["= /pma"] } }
  const r = render(fix, { cloudflareRanges: ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18"] })
  const rendered = r.ok ? r.rendered : { template: "deny-paths" as const, lines: ["location = /pma { return 403; }"], checks: [], notes: [] }
  const domain = f.scope.slice(5)
  const id = `20261122-120000-${f.id}`
  const block = [`# ${f.id} ${fix.template}: ${f.title} (proposal ${id})`, ...rendered.lines].join("\n")
  return { id, hash: "devmode000000000", todoId: f.id, title: f.title, domain, template: fix.template, params: fix.params, rendered, block, previous: "", file: block, diff: block.split("\n").map((l) => `+ ${l}`).join("\n"), createdAt: "", createdBy: "", status, appliedAt: status === "applied" ? "2026-11-22T12:00:00Z" : undefined }
}

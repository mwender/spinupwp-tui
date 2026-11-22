// Samurai's guided setup for one site, opened with F on a site (Servers tab,
// Search) or f on an nginx to-do whose site isn't set up yet. It checks the
// server, shows every step and every path the root step writes, and runs only
// on y. The work is lib/samurai/setup.ts, shared with
// `spinuptui samurai setup <domain>`.
//
// Dev Mode never touches a server: it shows a made-up plan and pretends.

import { useEffect, useRef, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered, Spinner } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { isDevMode } from "../../dev/devMode.ts"
import { getSudoPassword } from "../../lib/keychain.ts"
import { applySetup, planSetup, SAMURAI_FILE, type ApplyResult, type SetupContext, type SetupPlan } from "../../lib/samurai/setup.ts"
import type { Server, Site } from "../../api/types.ts"

type Ready = Extract<SetupPlan, { ok: true }>
type Phase =
  | { at: "checking" }
  | { at: "blocked"; message: string; remedy?: string }
  | { at: "plan"; plan: Ready; ctx: SetupContext }
  | { at: "running"; plan: Ready; lines: string[] }
  | { at: "done"; plan: Ready; result: ApplyResult; lines: string[] }
  | { at: "failed"; plan: Ready; message: string; remedy?: string; lines: string[] }

const WIDTH = 76

export function SamuraiSetup() {
  const { samuraiSetupSite: site, setSamuraiSetupSite, servers, sudoUserFor, sudoPasswordFor, sudoSavedFor } = useStore()
  const server = site ? servers.find((s) => s.id === site.server_id) : undefined
  const [phase, setPhase] = useState<Phase>({ at: "checking" })
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    if (!site || !server) return
    void (async () => {
      if (isDevMode()) {
        await new Promise((r) => setTimeout(r, 700))
        const plan = devPlan(site, server)
        if (live.current) setPhase({ at: "plan", plan, ctx: { domain: site.domain, site, server, sudo: { user: "sudouser", password: "x" } } })
        return
      }
      const user = sudoUserFor(server.id)
      let password = sudoPasswordFor(server.id)
      if (user && password == null && sudoSavedFor(server.id)) password = (await getSudoPassword(server.id)) ?? undefined
      const ctx: SetupContext = { domain: site.domain, site, server, sudo: user ? { user, password: password ?? "" } : null }
      const plan = await planSetup(ctx)
      if (!live.current) return
      if (!plan.ok) setPhase({ at: "blocked", message: plan.message, remedy: plan.remedy })
      else setPhase({ at: "plan", plan, ctx })
    })()
    return () => {
      live.current = false
    }
    // Plan once per opening; the overlay is reopened to re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.id])

  const close = () => setSamuraiSetupSite(null)
  const busy = phase.at === "running"
  const canRun = phase.at === "plan" && (!phase.plan.needsSudo || !!phase.ctx.sudo?.password)

  const go = () => {
    if (phase.at !== "plan" || !canRun) return
    const { plan, ctx } = phase
    const lines: string[] = []
    const add = (l: string) => {
      lines.push(l)
      if (live.current) setPhase({ at: "running", plan, lines: [...lines] })
    }
    setPhase({ at: "running", plan, lines })
    void (async () => {
      const r = isDevMode() ? await devApply(ctx.domain, add) : await applySetup(plan, ctx, add)
      if (!live.current) return
      if (r.ok) setPhase({ at: "done", plan, result: r, lines: [...lines] })
      else setPhase({ at: "failed", plan, message: r.message, remedy: r.remedy, lines: [...lines] })
    })()
  }

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (busy) return // a root step half done is worse than waiting a few seconds
    if (name === "escape" || name === "q") return close()
    if (name === "y") go()
  })

  if (!site) return null

  const hints =
    phase.at === "plan" && canRun && phase.plan.steps.some((s) => !s.done)
      ? [{ key: "y", label: phase.plan.needsSudo ? "set it up" : "refresh and re-check" }, { key: "esc", label: "cancel" }]
      : busy
        ? [{ key: "…", label: "working: this takes under a minute" }]
        : [{ key: "esc", label: "close" }]

  return (
    <box style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg, zIndex: 210 }}>
      <box style={{ flexDirection: "row", height: 1, backgroundColor: theme.bgAlt, paddingLeft: 1, paddingRight: 1, alignItems: "center" }}>
        <text content="⚔ Samurai setup  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        {server && <text content={truncate(server.name, 30)} fg={theme.textFaint} wrapMode="none" style={{ flexShrink: 0 }} />}
      </box>
      <Centered>{body()}</Centered>
      <StatusBar hints={hints} showGlobal={false} />
    </box>
  )

  function body() {
    if (phase.at === "checking") {
      return (
        <Panel title=" Checking " active>
          <box style={{ flexDirection: "row", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <Spinner />
            <text content={` Reading ${server?.name ?? "the server"} (read-only)…`} fg={theme.textDim} />
          </box>
        </Panel>
      )
    }
    if (phase.at === "blocked") {
      return (
        <Panel title=" Can't set up yet " active>
          <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
            <text content={phase.message} fg={theme.text} />
            {phase.remedy && <box style={{ height: 1 }} />}
            {phase.remedy && <text content={phase.remedy} fg={theme.textDim} />}
          </box>
        </Panel>
      )
    }
    if (phase.at === "plan") return planBody(phase.plan, phase.ctx)
    return runBody()
  }

  function planBody(plan: Ready, ctx: SetupContext) {
    const todo = plan.steps.filter((s) => !s.done)
    return (
      <Panel title={todo.length > 2 ? " What setup will do " : " Already set up "} active>
        <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
          <text content={`Samurai deploys this site's nginx rules through a small root-owned gate, which may only write ${SAMURAI_FILE} and checks every change with nginx -t, rolling back if it fails.`} fg={theme.textDim} />
          <box style={{ height: 1 }} />
          {plan.steps.map((s, i) => (
            <box key={s.id} style={{ flexDirection: "column" }}>
              <box style={{ flexDirection: "row" }}>
                <text content={s.done ? " ✓ " : ` ${i + 1}. `} fg={s.done ? theme.good : theme.accent} style={{ flexShrink: 0 }} />
                <text content={s.title} fg={s.done ? theme.textDim : theme.text} wrapMode="none" />
              </box>
              {!s.done && (
                <box style={{ paddingLeft: 4 }}>
                  <text content={s.detail} fg={theme.textFaint} />
                </box>
              )}
            </box>
          ))}
          {plan.needsSudo && (
            <>
              <box style={{ height: 1 }} />
              <text content={`As root, through ${plan.sshTarget}, it writes:`} fg={theme.warn} />
              {plan.writes.map((w) => (
                <text key={w} content={`  ${w}`} fg={theme.textDim} wrapMode="none" />
              ))}
            </>
          )}
          {plan.needsSudo && !ctx.sudo?.password && (
            <>
              <box style={{ height: 1 }} />
              <text content={`It needs ${ctx.sudo?.user ?? "the sudo user"}'s password: connect sudo on ${ctx.server.name} first (S on it in the Servers tab), then press F again.`} fg={theme.bad} />
            </>
          )}
          <box style={{ height: 1 }} />
          <text
            content={canRun ? (plan.needsSudo ? "Press y to set it up · Esc to cancel" : "Press y to refresh the copy and prove it again · Esc to close") : "Esc to close"}
            fg={theme.textFaint}
            wrapMode="none"
          />
        </box>
      </Panel>
    )
  }

  function runBody() {
    if (phase.at !== "running" && phase.at !== "done" && phase.at !== "failed") return null
    const title = phase.at === "running" ? " Setting up " : phase.at === "done" ? " Set up " : " Setup stopped "
    return (
      <Panel title={title} active>
        <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
          {phase.lines.map((l, i) => {
            const last = i === phase.lines.length - 1
            const mark = phase.at === "running" && last ? null : phase.at === "failed" && last ? " ✗ " : " ✓ "
            return (
              <box key={i} style={{ flexDirection: "row" }}>
                {mark ? <text content={mark} fg={mark === " ✗ " ? theme.bad : theme.good} style={{ flexShrink: 0 }} /> : <box style={{ width: 3, flexShrink: 0 }}><Spinner /></box>}
                <text content={l} fg={theme.text} wrapMode="none" />
              </box>
            )
          })}
          <box style={{ height: 1 }} />
          {phase.at === "done" && (
            <>
              <text content={`${phase.plan.domain} is set up for Samurai. It answered ${phase.result.before ?? "nothing"} before the push and ${phase.result.after} after.`} fg={theme.good} />
              <text content="Its nginx rules can now be applied from its to-dos." fg={theme.textDim} />
            </>
          )}
          {phase.at === "failed" && (
            <>
              <text content={phase.message} fg={theme.bad} />
              {phase.remedy && <text content={phase.remedy} fg={theme.textDim} />}
              <text content="Press F again once that's sorted: setup picks up where it stopped." fg={theme.textFaint} />
            </>
          )}
        </box>
      </Panel>
    )
  }
}

// ---- Dev Mode -----------------------------------------------------------------

function devPlan(site: Site, server: Server): Ready {
  const ip = server.ip_address ?? "203.0.113.10"
  return {
    ok: true,
    domain: site.domain,
    sshTarget: `sudouser@${ip}`,
    gateTarget: { ip, port: null, keyPath: "/dev/null" },
    state: { siteDir: true, realip: true, gate: null, allowed: null, keys: [], oldGateSite: false, samuraiFile: false },
    steps: [
      { id: "check", title: "Check the server", detail: "", done: true },
      { id: "gate", title: "Install the gate", detail: "As root: the gate at /usr/local/sbin/spinuptui-nginx, a sudoers rule letting the spinuptui-nginx user run that one command, and that user.", done: false },
      { id: "key", title: "Make this machine's deploy key", detail: `A new ed25519 key, used only for ${site.domain}'s nginx rules.`, done: false },
      { id: "register", title: `Register ${site.domain} with the gate`, detail: `As root: allow ${SAMURAI_FILE} and nothing else, for this machine's deploy key.`, done: false },
      { id: "mirror", title: "Copy its nginx config here", detail: "A git repository of the live config. Certificates and keys never leave the server.", done: false },
      { id: "prove", title: "Prove it end to end", detail: `Push an empty ${SAMURAI_FILE} through the gate, then check the site still answers as before.`, done: false },
    ],
    needsSudo: true,
    writes: ["/usr/local/sbin/spinuptui-nginx", "/etc/sudoers.d/spinuptui-nginx", `/etc/spinuptui/nginx/sites/${site.domain}.allowed`, `/etc/spinuptui/nginx/sites/${site.domain}.pub`, "/home/spinuptui-nginx/.ssh/authorized_keys", "user spinuptui-nginx"],
    allow: [SAMURAI_FILE],
    keys: [],
    localKey: { path: "/dev/null", exists: false, pub: null },
    mirror: { path: "/dev/null", exists: false },
    notes: [],
  }
}

async function devApply(domain: string, add: (l: string) => void): Promise<ApplyResult> {
  const steps = ["Making this machine's deploy key", "Installing the gate and registering the site (as root)", "Checking the gate answers to this machine's key", "Copying the site's nginx config here", `Checking ${domain} from outside, before`, `Pushing ${SAMURAI_FILE} through the gate (nginx -t, then reload)`, `Checking ${domain} from outside, after`]
  for (const s of steps) {
    add(s)
    await new Promise((r) => setTimeout(r, 450))
  }
  return { ok: true, mirrorChanged: true, deployLog: "", before: 200, after: 200 }
}

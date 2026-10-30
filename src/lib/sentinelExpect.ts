// Expectation checks: what uptime monitoring can't see. A crawler that stopped
// arriving, a cache that stopped hitting, a box that latches under load. They run
// with the digest, read-only through ssh-exec, and report on the previous full
// day: at 08:00 today's log is only a few hours old and would read as a collapse.
//
// A failed probe is "unverified", never a pass and never a flag. Commands avoid a
// bare `>` and multi-parameter URLs, which the ssh-exec policy reads as a redirect
// and a shell operator (docs/2026-10-30_sentinel-spec.md, "Expectations").

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseDate } from "./schedule.ts"
import { expectationsPath, trendsPath, writeJson } from "./sentinelState.ts"

interface Base {
  id: string
  domain?: string
  server?: string // when the domain exists on more than one server
  label?: string
  note?: string
  expires?: string
}

export type Expectation = Base &
  (
    | { type: "log-count"; domain: string; match: string; min?: number; trend?: boolean }
    | { type: "load-shape"; domain: string; threshold: number }
    | { type: "cache-hit"; domain: string; host: string; paths: string[] }
    | { type: "warmer"; domain: string; logGlob: string }
    | { type: "status"; url: string; expect: number }
  )

export const EXPECT_TYPES = ["log-count", "load-shape", "cache-hit", "warmer", "status"] as const
const ID_RE = /^[a-z0-9][a-z0-9-]{1,79}$/
const DOMAIN_RE = /^[a-z0-9.-]+$/i
const LATCHED_SAMPLES = 3
// `sar` writes a sample every 10 minutes.
const SAMPLE_MIN = 10

export function loadExpectations(): Expectation[] {
  try {
    return JSON.parse(readFileSync(expectationsPath(), "utf8")) as Expectation[]
  } catch {
    return []
  }
}

export const saveExpectations = (list: Expectation[]) => writeJson(expectationsPath(), list)

// Everything here ends up inside a remote shell string, so each value is held to
// what it needs to be rather than escaped and hoped for.
export function validateExpectation(e: Expectation): string[] {
  const p: string[] = []
  if (!ID_RE.test(e.id ?? "")) p.push("id must be lowercase letters, digits and hyphens")
  if (!(EXPECT_TYPES as readonly string[]).includes(e.type)) p.push(`type must be one of ${EXPECT_TYPES.join(", ")}`)
  if (e.expires) {
    try {
      parseDate(e.expires)
    } catch (err) {
      p.push((err as Error).message)
    }
  }
  if (e.type !== "status" && !DOMAIN_RE.test(e.domain ?? "")) p.push("domain is required")
  if (e.type === "log-count") {
    if (!e.match) p.push("match is required")
    if (/["$`\\\n>]/.test(e.match ?? "")) p.push('match can\'t contain " $ ` \\ or >')
    if (e.min !== undefined && !(e.min >= 0)) p.push("min must be a number")
  }
  if (e.type === "load-shape" && !(e.threshold > 0)) p.push("threshold must be a positive number")
  if (e.type === "cache-hit") {
    if (!DOMAIN_RE.test(e.host ?? "")) p.push("host is required: the site's canonical host")
    if (!e.paths?.length) p.push("paths is required")
    for (const path of e.paths ?? []) if (!/^\/[\w./?=%-]*$/.test(path) || path.includes("&")) p.push(`${path}: a path may carry one query parameter and no shell characters`)
  }
  if (e.type === "warmer" && !/^[\w./~*-]+$/.test(e.logGlob ?? "")) p.push("logGlob is required, as a plain path with * wildcards")
  if (e.type === "status") {
    if (!/^https?:\/\//.test(e.url ?? "")) p.push("url is required")
    if (!(e.expect >= 100)) p.push("expect is required: the status code")
  }
  return p
}

// ---- the remote commands ----------------------------------------------------------------

// grep -c exits 1 on a zero count, so callers read stdout rather than the exit code.
export const logCountCommand = (match: string) => `zcat ~/logs/access.log-$(date +%Y%m%d).gz 2>/dev/null | grep -cF "${match}"`

// `!(x < T)` and `if (mx < x)` rather than `x >= T`: the guard reads a bare > as a
// redirect and denies the whole command.
export const loadShapeCommand = (threshold: number) =>
  String.raw`LC_ALL=C sar -q -f /var/log/sysstat/sa$(date -d yesterday +%d) 2>/dev/null | awk -v T=${threshold} "\$4 ~ /^[0-9.]+\$/ {n++; if (!(\$4+0 < T)) {run++; over++; if (mxrun < run) mxrun=run} else {run=0}; if (mx < \$4+0) mx=\$4} END {printf \"%s %d %d\\n\", (mx==\"\"?0:mx), over+0, mxrun+0}"`

// No `-o /dev/null`: the guard reads an output flag as a redirect, so the body
// falls through and grep picks the header out of it.
export const cacheProbeCommand = (host: string, path: string) =>
  String.raw`for i in 1 2; do curl -s -D - --max-time 15 --resolve ${host}:443:127.0.0.1 "https://${host}${path}"; done | grep -i "^fastcgi-cache:" | tail -1 | awk "{print \$2}"`

export const warmerCommand = (glob: string) => `L=$(ls -t ${glob} 2>/dev/null | head -1); [ -n "$L" ] && grep -hoE "starting: [0-9]+ URLs queued" "$L" | grep -oE "[0-9]+" | head -1`

export const APT_COMMAND =
  'echo $(stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null || echo none) $(date +%s) $(systemctl show apt-daily.service -p ActiveState --value) $(date -d "$(systemctl show apt-daily.service -p StateChangeTimestamp --value)" +%s 2>/dev/null || echo 0)'

// ---- running one ---------------------------------------------------------------------------

export type ExpectState = "ok" | "flag" | "unverified"

export interface ExpectResult {
  id: string
  label: string
  state: ExpectState
  text: string
  trend?: string
}

export interface ExpectDeps {
  // stdout, or null when the probe itself failed.
  exec(domain: string, command: string, server?: string): Promise<string | null>
  status(url: string): Promise<number | null>
}

const labelOf = (e: Expectation) => e.label ?? e.id
const num = (s: string | null) => (s !== null && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null)

export async function runExpectation(e: Expectation, deps: ExpectDeps): Promise<ExpectResult> {
  const r = (state: ExpectState, text: string, trend?: string): ExpectResult => ({ id: e.id, label: labelOf(e), state, text, ...(trend !== undefined ? { trend } : {}) })
  switch (e.type) {
    case "log-count": {
      const n = num(await deps.exec(e.domain, logCountCommand(e.match), e.server))
      if (n === null) return r("unverified", "no count returned")
      const trend = e.trend ? String(n) : undefined
      if (e.min !== undefined && n < e.min) return r("flag", `LOW: ${n} yesterday (expected ≥${e.min})`, trend)
      return r("ok", String(n), trend)
    }
    case "load-shape": {
      const out = (await deps.exec(e.domain, loadShapeCommand(e.threshold), e.server))?.trim().split(/\s+/)
      if (out?.length !== 3 || !/^[\d.]+$/.test(out[0]!) || !/^\d+$/.test(out[1]!) || !/^\d+$/.test(out[2]!)) return r("unverified", "no sar data")
      const [max, over, run] = [out[0]!, Number(out[1]), Number(out[2])]
      const shape = `load max ${max}, ${over} over ${e.threshold}, longest ${run * SAMPLE_MIN} min`
      return run >= LATCHED_SAMPLES ? r("flag", `LATCHED: ${shape}`) : r("ok", shape)
    }
    case "cache-hit": {
      const bad: string[] = []
      let probes = 0
      for (const path of e.paths) {
        const got = (await deps.exec(e.domain, cacheProbeCommand(e.host, path), e.server))?.trim()
        if (got) probes++
        if (got?.toUpperCase() !== "HIT") bad.push(`${path}=${got || "no answer"}`)
      }
      if (!probes) return r("unverified", "no answer from any path")
      return bad.length ? r("flag", `CACHE REGRESSED: ${bad.join(", ")}`) : r("ok", `${e.paths.length} path(s) HIT`)
    }
    case "warmer": {
      const n = num(await deps.exec(e.domain, warmerCommand(e.logGlob), e.server))
      if (n === null) return r("unverified", "no warmer log found")
      return n === 0 ? r("flag", "WARMER IDLE: 0 queued") : r("ok", `${n} queued`)
    }
    case "status": {
      const code = await deps.status(e.url)
      if (code === null) return r("unverified", "no response")
      return code === e.expect ? r("ok", String(code)) : r("flag", `${e.url} returned ${code} (expected ${e.expect})`)
    }
  }
}

export function appendTrends(results: ExpectResult[], date: string): void {
  const rows = results.filter((r) => r.trend !== undefined).map((r) => `${date},${r.id},${r.trend}`)
  if (!rows.length) return
  const path = trendsPath()
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) appendFileSync(path, "date,id,value\n")
  appendFileSync(path, rows.join("\n") + "\n")
}

// ---- apt freshness, for every server -----------------------------------------------------------

const APT_STALE_DAYS = 3
const APT_STUCK_HOURS = 6

// Catches a server whose updates quietly stopped: a daily `apt-get update` that
// hung and held the lock for over a year once, with the sites up and nothing
// paging. null means the output didn't parse.
export function readApt(output: string | null): { flag: string | null } | null {
  const [stamp, nowS, state, since] = (output ?? "").trim().split(/\s+/)
  if (!/^\d+$/.test(nowS ?? "")) return null
  const now = Number(nowS)
  const flags: string[] = []
  if (!stamp || stamp === "none") flags.push("STALE: no successful update on record")
  else {
    const days = Math.floor((now - Number(stamp)) / 86_400)
    if (days > APT_STALE_DAYS) flags.push(`STALE: last successful update ${days}d ago`)
  }
  if (state === "activating" && /^[1-9]\d*$/.test(since ?? "")) {
    const hours = Math.floor((now - Number(since)) / 3600)
    if (hours > APT_STUCK_HOURS) flags.push(`STUCK: apt-daily running ${hours > 48 ? `${Math.floor(hours / 24)}d` : `${hours}h`}`)
  }
  return { flag: flags.length ? flags.join("; ") : null }
}

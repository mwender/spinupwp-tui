// `spinuptui siblings <domain>` — every site sharing a server with this one,
// for external tooling (e.g. an incident-diagnostics agent handed one domain).
//
// The motivating case: a server's vanity host pages on `?healthz`, but the
// vanity site is an empty placeholder — the load is always a co-tenant, and
// site isolation means the vanity user can't read the neighbour's logs. The
// agent needs to know who else lives on the box, and which of them it can
// actually SSH into, before it can find the request-level cause. Answering that
// from the API takes two calls; discovering it by hand took weeks.

import type { AppConfig } from "../config.ts"
import type { Server, Site } from "../api/types.ts"
import type { SpinupWPClientLike } from "../api/client.ts"
import { ApiError } from "../api/client.ts"
import {
  resolveSiteByDomain,
  probeSshTarget,
  type SshAccessReason,
  type SshAccessCandidate,
  type SshProbeStatus,
} from "./cliSsh.ts"
import { hasIncidentMonitors } from "./cliIncidents.ts"
import { resolveSiteSshTarget } from "./probe.ts"
import { isVanityPair } from "./vanitySite.ts"

// Why a co-tenant's logs may be out of reach. `ok` means this device's key is
// accepted for that site user; `permission_denied` is the one worth acting on
// (grant the key with K in the Browser view) and the usual reason a neighbour's
// access log can't be read.
export type SiblingSshStatus = SshProbeStatus

export interface SiblingSite {
  domain: string
  siteUser: string | null
  sshTarget: string
  isWordPress: boolean
  phpVersion: string | null
  pageCache: boolean | null
  // The site living at the server's own hostname — a placeholder whose monitors
  // report on the whole box, so its pages are rarely about itself.
  isVanity: boolean
  // Has Uptime Kuma monitors registered through SpinupTUI, so `spinuptui
  // incidents <domain>` will return something for it.
  monitored: boolean
  // The domain that was asked about, so a caller can tell itself apart from the
  // neighbours without re-matching on additional domains.
  isQuery: boolean
  // Only present with --probe.
  ssh?: SiblingSshStatus
  sshMessage?: string
}

export interface SiblingsServer {
  id: number
  name: string
  ip: string | null
  // Needed alongside each site's sshTarget; null means the default, 22.
  sshPort: number | null
  provider: string | null
  size: string | null
  ubuntuVersion: string | null
}

export type SiblingsResult =
  | {
      ok: true
      domain: string
      primaryDomain: string
      server: SiblingsServer
      siteCount: number
      sites: SiblingSite[]
    }
  | {
      ok: false
      domain: string
      reason: SshAccessReason
      message: string
      remedy?: string
      candidates?: SshAccessCandidate[]
    }

// Every probe hits the same sshd, so they're capped rather than all fired at
// once: OpenSSH's default MaxStartups (10:30:100) starts dropping connections
// that are still authenticating past 10, which would turn a big server's
// result into random connection failures. A small burst of refused logins is
// also gentler on any fail2ban-style guard watching that sshd.
const PROBE_CONCURRENCY = 4

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function describe(site: Site, server: Server, cfg: AppConfig, queryId: number): SiblingSite {
  return {
    domain: site.domain,
    siteUser: site.site_user,
    sshTarget: resolveSiteSshTarget(site, server, cfg.sshUser),
    isWordPress: site.is_wordpress,
    phpVersion: site.php_version,
    pageCache: site.page_cache ? site.page_cache.enabled : null,
    isVanity: isVanityPair(site.domain, server.name),
    monitored: hasIncidentMonitors(cfg.kumaMonitors[site.domain]),
    isQuery: site.id === queryId,
  }
}

export async function resolveSiblings(
  domain: string,
  client: SpinupWPClientLike,
  cfg: AppConfig,
  opts?: { server?: string | null; probe?: boolean },
): Promise<SiblingsResult> {
  const resolved = await resolveSiteByDomain(domain, client, cfg, { server: opts?.server ?? null })
  if (!resolved.ok) return resolved.result

  const { site, server } = resolved

  let siteList: Site[]
  try {
    siteList = await client.listSites(server.id)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return {
        ok: false,
        domain,
        reason: "token_rejected",
        message: "Saved API token was rejected (401) — it may be expired or revoked.",
        remedy: "Run `spinuptui login` to save a fresh token.",
      }
    }
    const message = err instanceof ApiError ? err.message : `Unexpected error: ${(err as Error).message}`
    return { ok: false, domain, reason: "api_error", message }
  }

  // The vanity host first, then the queried site, then alphabetically: a reader
  // scanning the list sees what the box calls itself before its tenants.
  const sorted = [...siteList].sort((a, b) => {
    const rank = (s: Site) =>
      isVanityPair(s.domain, server.name) ? 0 : s.id === site.id ? 1 : 2
    return rank(a) - rank(b) || a.domain.localeCompare(b.domain)
  })

  const sites = sorted.map((s) => describe(s, server, cfg, site.id))
  const port = server.ssh_port && server.ssh_port !== 22 ? server.ssh_port : null

  // resolveSiteByDomain has already refused a server with no IP, so every
  // sshTarget here is a real user@ip.
  if (opts?.probe) {
    const probes = await mapLimit(sites, PROBE_CONCURRENCY, (s) => probeSshTarget(s.sshTarget, port))
    probes.forEach((p, i) => {
      sites[i]!.ssh = p.status
      if (p.message) sites[i]!.sshMessage = p.message
    })
  }

  return {
    ok: true,
    domain,
    primaryDomain: site.domain,
    server: {
      id: server.id,
      name: server.name,
      ip: server.ip_address,
      sshPort: port,
      provider: server.provider_name,
      size: server.size,
      ubuntuVersion: server.ubuntu_version,
    },
    siteCount: sites.length,
    sites,
  }
}

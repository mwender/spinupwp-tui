// DNS provider access layer (Phase 2, read-only verification) — a small registry
// so adding a provider is one entry, not edits across the app.
//
// Two namespaces meet here:
//   - host providerKey (from dns.ts): who answers DNS live — route53 | cloudflare
//     | godaddy | <fallback domain> …  (what the HOST column shows)
//   - connection provider: who we can hold credentials for — see ConnProvider
// apiProviderFor() bridges them via each descriptor's `hostKeys`.
//
// "Verify" = list the zones a credential can actually see (and, where the API
// returns them for free, each zone's assigned nameservers). That data drives the
// ACCESS column: a zone is editable only when a connected account of the SAME
// provider that hosts it contains it — and, when nameservers are known, only when
// they match the live authoritative NS (so a stale/duplicate zone doesn't count).

import { awsGet } from "./awsSigV4.ts"

export type ConnProvider = "aws" | "cloudflare" | "godaddy"

// A stored credential for a provider. `creds` is a provider-specific bag (the
// descriptor's `fields` define its keys); secrets live in config.json (0600).
export interface Connection {
  id: string
  provider: ConnProvider
  label: string
  creds: Record<string, string>
  env?: boolean // sourced from environment (read-only in the UI)
}

export interface VerifiedZone {
  apex: string
  account: string // account identifier/name as the provider reports it
  nameservers: string[] // assigned NS (lowercased, sorted); [] when the API didn't return them
}

export interface VerifyResult {
  ok: boolean
  zones: VerifiedZone[]
  accountLabel: string // a default connection label derived from the account(s) seen
  error?: string
}

// A credential field rendered in the connect form (besides the always-present label).
export interface ProviderField {
  name: string // key in Connection.creds
  label: string
  secret?: boolean // render masked (SecretInput)
  optional?: boolean
  placeholder?: string
}

export interface ProviderDescriptor {
  key: ConnProvider
  name: string // e.g. "AWS (Route 53)"
  hostKeys: string[] // dns.ts providerKeys that map to this connection provider
  fields: ProviderField[]
  guidance: string // help line under the form
  // Optional web handoff for the "no API access" fallback (e.g. GoDaddy, whose API
  // is gated to large accounts). When set, an unconnected zone shows `↗ web` instead
  // of `○ needs key`, and the connect overlay offers `w` to open `console`.
  console?: string
  consoleLabel?: string // button/hint text for the handoff (default "web console")
  // Longer in-overlay note shown when `console` is set — explains the assumed
  // access model + the handoff flow.
  accessNote?: string
  verify: (creds: Record<string, string>) => Promise<VerifyResult>
}

function normApex(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "")
}

// Normalize a nameserver set for comparison: lowercase, drop trailing dots, sort.
export function normNameservers(ns: string[] | undefined): string[] {
  return (ns ?? []).map((s) => s.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean).sort()
}

export function nameserversMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// ---- Cloudflare ------------------------------------------------------------

async function verifyCloudflare(creds: Record<string, string>): Promise<VerifyResult> {
  const token = creds.token ?? ""
  try {
    const zones: VerifiedZone[] = []
    const accounts = new Set<string>()
    let page = 1
    let totalPages = 1
    do {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      })
      const json = (await res.json()) as {
        success?: boolean
        errors?: { message?: string }[]
        result?: { name: string; name_servers?: string[]; account?: { name?: string } }[]
        result_info?: { total_pages?: number }
      }
      if (!res.ok || !json.success) {
        return { ok: false, zones: [], accountLabel: "", error: json?.errors?.[0]?.message || `HTTP ${res.status}` }
      }
      for (const z of json.result ?? []) {
        zones.push({ apex: normApex(z.name), account: z.account?.name ?? "", nameservers: normNameservers(z.name_servers) })
        if (z.account?.name) accounts.add(z.account.name)
      }
      totalPages = json.result_info?.total_pages ?? 1
      page++
    } while (page <= totalPages)
    const accountLabel = accounts.size === 1 ? [...accounts][0] : accounts.size > 1 ? `${accounts.size} accounts` : "Cloudflare"
    return { ok: true, zones, accountLabel }
  } catch (err) {
    return { ok: false, zones: [], accountLabel: "", error: (err as Error).message }
  }
}

// ---- AWS Route 53 (hand-rolled SigV4) --------------------------------------

function awsErrorMessage(xml: string): string | null {
  return xml.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? null
}

async function verifyAws(creds: Record<string, string>): Promise<VerifyResult> {
  const aws = { accessKeyId: creds.accessKeyId ?? "", secretAccessKey: creds.secretAccessKey ?? "", region: creds.region || undefined }
  try {
    const sts = await awsGet(aws, "sts", "sts.amazonaws.com", "/", { Action: "GetCallerIdentity", Version: "2011-06-15" })
    if (sts.status !== 200) {
      return { ok: false, zones: [], accountLabel: "", error: awsErrorMessage(sts.body) || `STS HTTP ${sts.status}` }
    }
    const accountId = sts.body.match(/<Account>([^<]+)<\/Account>/)?.[1] ?? ""

    // Route 53 ListHostedZones (paginate). We deliberately do NOT fetch each
    // zone's nameservers (GetHostedZone is one call per zone and Route 53 caps at
    // ~5 req/s — 27s+ for a large account). AWS zones therefore use membership-
    // based access (provider-scoped); nameservers stay [] → NS-match falls back.
    const zones: VerifiedZone[] = []
    let marker: string | undefined
    do {
      const query: Record<string, string> = { maxitems: "100" }
      if (marker) query.marker = marker
      const r = await awsGet(aws, "route53", "route53.amazonaws.com", "/2013-04-01/hostedzone", query)
      if (r.status !== 200) {
        return { ok: false, zones: [], accountLabel: "", error: awsErrorMessage(r.body) || `Route 53 HTTP ${r.status}` }
      }
      for (const block of r.body.split(/<HostedZone>/).slice(1)) {
        const name = block.match(/<Name>([^<]+)<\/Name>/)?.[1]
        if (name) zones.push({ apex: normApex(name), account: accountId, nameservers: [] })
      }
      marker = /<IsTruncated>true<\/IsTruncated>/.test(r.body)
        ? r.body.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1]
        : undefined
    } while (marker)

    return { ok: true, zones, accountLabel: accountId || "AWS" }
  } catch (err) {
    return { ok: false, zones: [], accountLabel: "", error: (err as Error).message }
  }
}

// ---- GoDaddy (header auth, no signing) -------------------------------------

async function verifyGodaddy(creds: Record<string, string>): Promise<VerifyResult> {
  const key = creds.apiKey ?? ""
  const secret = creds.apiSecret ?? ""
  try {
    const res = await fetch("https://api.godaddy.com/v1/domains?statuses=ACTIVE&limit=1000", {
      headers: { Authorization: `sso-key ${key}:${secret}`, Accept: "application/json" },
    })
    if (!res.ok) {
      // GoDaddy gates API access (≈20+ domains / reseller tiers); 403 means this
      // account can't use the API — the zone stays a web-only (↗) handoff.
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      const msg = res.status === 403 ? "This GoDaddy account has no API access (needs 20+ domains / reseller)." : body.message || `HTTP ${res.status}`
      return { ok: false, zones: [], accountLabel: "", error: msg }
    }
    const list = (await res.json()) as { domain: string; nameServers?: string[] }[]
    const zones: VerifiedZone[] = list.map((d) => ({
      apex: normApex(d.domain),
      account: "godaddy",
      nameservers: normNameservers(d.nameServers),
    }))
    return { ok: true, zones, accountLabel: "GoDaddy" }
  } catch (err) {
    return { ok: false, zones: [], accountLabel: "", error: (err as Error).message }
  }
}

// ---- Registry --------------------------------------------------------------

export const PROVIDER_REGISTRY: Record<ConnProvider, ProviderDescriptor> = {
  aws: {
    key: "aws",
    name: "AWS (Route 53)",
    hostKeys: ["route53"],
    fields: [
      { name: "accessKeyId", label: "Access Key ID", placeholder: "AKIA…" },
      { name: "secretAccessKey", label: "Secret Access Key", secret: true, placeholder: "secret" },
      { name: "region", label: "Region (optional, default us-east-1)", optional: true, placeholder: "us-east-1" },
    ],
    guidance: "IAM perms: route53 ListHostedZonesByName + ListResourceRecordSets to view; add ChangeResourceRecordSets + GetChange to edit TTLs.",
    verify: verifyAws,
  },
  cloudflare: {
    key: "cloudflare",
    name: "Cloudflare",
    hostKeys: ["cloudflare"],
    fields: [{ name: "token", label: "API token — DNS:Read to view, DNS:Edit to change TTLs", secret: true, placeholder: "Cloudflare API token" }],
    guidance: "Create one at dash.cloudflare.com → My Profile → API Tokens (Zone DNS:Edit to edit records).",
    verify: verifyCloudflare,
  },
  godaddy: {
    key: "godaddy",
    name: "GoDaddy",
    hostKeys: ["godaddy"],
    fields: [
      { name: "apiKey", label: "API Key", placeholder: "key" },
      { name: "apiSecret", label: "API Secret", secret: true, placeholder: "secret" },
    ],
    guidance:
      "At developer.godaddy.com → Create New API Key, choose Environment = Production (NOT OTE/test). GoDaddy's API is only available to larger accounts (≈20+ domains / reseller); without it, use w for the Clients hub.",
    console: "https://hub.godaddy.com/clients?view=table",
    consoleLabel: "Clients hub",
    accessNote:
      "Spinup assumes you manage GoDaddy domains via Delegate Access from one main account. Press w to open your Clients hub (the domain is copied to your clipboard) → Login as the client → paste the domain → Exit access before checking the next.",
    verify: verifyGodaddy,
  },
}

export const ALL_PROVIDERS: ConnProvider[] = Object.keys(PROVIDER_REGISTRY) as ConnProvider[]

// Map a live host providerKey to the connection provider we can authenticate as.
export function apiProviderFor(hostKey: string): ConnProvider | null {
  for (const d of Object.values(PROVIDER_REGISTRY)) if (d.hostKeys.includes(hostKey)) return d.key
  return null
}

export function verifyConnection(conn: Connection): Promise<VerifyResult> {
  return PROVIDER_REGISTRY[conn.provider].verify(conn.creds)
}

// Best-effort web-console deep links for hosts we can't (or don't yet) drive via
// API — the `↗ web only` handoff. API providers normally resolve to editable/
// needs-key before reaching here.
export const PROVIDER_CONSOLE: Record<string, string> = {
  namecheap: "https://ap.www.namecheap.com/domains/list",
  dnsme: "https://dnsmadeeasy.com",
  digitalocean: "https://cloud.digitalocean.com/networking/domains",
  google: "https://domains.google.com/registrar",
  netsol: "https://www.networksolutions.com/my-account",
  dreamhost: "https://panel.dreamhost.com",
  azure: "https://portal.azure.com",
  linode: "https://cloud.linode.com/domains",
  vultr: "https://my.vultr.com/dns/",
}

// The web handoff (URL + label) for a host, if any: an API provider's console
// (e.g. GoDaddy's Clients hub), else a web-only host's console. null for hosts
// managed purely via API (Route 53 / Cloudflare) or unrecognized fallbacks.
export function consoleForHost(hostKey: string): { url: string; label: string } | null {
  const prov = apiProviderFor(hostKey)
  if (prov) {
    const d = PROVIDER_REGISTRY[prov]
    return d.console ? { url: d.console, label: d.consoleLabel ?? "web console" } : null
  }
  const url = PROVIDER_CONSOLE[hostKey]
  return url ? { url, label: "web console" } : null
}

export type AccessState = "editable" | "needs-key" | "web" | "unknown"

// NOTE: the access decision is computed in the store (accessForZone) — it has the
// connection data — and is PROVIDER-SCOPED + NS-aware. See store.tsx.

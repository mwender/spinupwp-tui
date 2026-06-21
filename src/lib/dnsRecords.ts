// DNS record access layer (Phase 3) — the read + first-write slice for editing a
// record's TTL directly at the host, since SpinupWP's API doesn't manage DNS
// records. Mirrors the providers.ts registry shape: one descriptor per editable
// provider, so the overlay and store stay provider-agnostic.
//
// The unit here is the RECORD (within a zone), not the zone. We only ever touch
// ONE field — the TTL — so a record is "editable" only when changing its TTL is
// well-defined: not a Route 53 alias (no TTL), not a routing-policy set (TTL edit
// would need the whole policy echoed back), and not a Cloudflare proxied record
// (its TTL is forced to automatic). Everything else surfaces but is read-only.
//
// Two providers are wired: AWS Route 53 (hand-rolled SigV4; the write is an async
// ChangeResourceRecordSets we poll to INSYNC) and Cloudflare (REST; the PATCH is
// synchronous). GoDaddy stays a web handoff — its API is gated, like in Phase 2.

import { awsGet, awsPost, type AwsCreds } from "./awsSigV4.ts"
import type { ConnProvider } from "./providers.ts"

export interface DnsRecord {
  key: string // stable row key (Route 53: name|type; Cloudflare: record id)
  recordId?: string // provider record id (Cloudflare PATCH target)
  name: string // record name (trailing dot stripped)
  type: string // A, AAAA, CNAME, MX, TXT, …
  ttl: number | null // current TTL in seconds; null when the record carries no TTL
  values: string[] // record value(s) — shown, and echoed back on a Route 53 upsert
  editable: boolean // can we change THIS record's TTL?
  reason?: string // when not editable, the short why (alias / proxied / policy)
}

export interface ListResult {
  ok: boolean
  zoneId: string // provider zone id (needed again for the write); "" on failure
  records: DnsRecord[]
  error?: string
}

export interface ChangeResult {
  ok: boolean
  // Route 53 applies the change asynchronously; pollId is its change id (poll to
  // INSYNC). Absent (Cloudflare) means the change already took effect.
  pollId?: string
  error?: string
}

export type ChangeStatus = "pending" | "done" | "failed"

export interface RecordProvider {
  // List a zone's records (and return the provider zone id for the follow-up write).
  listRecords(creds: Record<string, string>, apex: string): Promise<ListResult>
  // Change one record's TTL. `zoneId` comes from listRecords; `record` carries the
  // values to preserve (Route 53 needs the full set on an upsert).
  setTtl(creds: Record<string, string>, zoneId: string, record: DnsRecord, ttl: number): Promise<ChangeResult>
  // Poll an async change to completion. Only providers that return a pollId set this.
  pollChange?(creds: Record<string, string>, pollId: string): Promise<ChangeStatus>
}

// ---- TTL presets + helpers -------------------------------------------------

// Common TTLs offered in the picker. The record's current value is always shown
// too, so any existing TTL is selectable even when it's not on this list.
export const TTL_PRESETS: { ttl: number; label: string }[] = [
  { ttl: 300, label: "5 minutes" },
  { ttl: 1800, label: "30 minutes" },
  { ttl: 3600, label: "1 hour" },
  { ttl: 14400, label: "4 hours" },
  { ttl: 43200, label: "12 hours" },
  { ttl: 86400, label: "1 day" },
]

// Sane bounds for the TTL editor. Cloudflare rejects sub-60s TTLs (other than its
// "automatic" sentinel, which the proxied/auto guard already excludes); Route 53
// allows lower, but a 1-week ceiling keeps the custom input from fat-fingering a
// value far outside what anyone wants here.
const TTL_MAX = 604800 // 7 days
const TTL_MIN: Record<ConnProvider, number> = { aws: 1, cloudflare: 60, godaddy: 60 }

// Validate a custom TTL for a provider. Returns an error string, or null when ok.
export function validateTtl(provider: ConnProvider, ttl: number): string | null {
  if (!Number.isInteger(ttl)) return "TTL must be a whole number of seconds."
  const min = TTL_MIN[provider]
  if (ttl < min) return `TTL must be at least ${min}s for this provider.`
  if (ttl > TTL_MAX) return `TTL can't exceed ${TTL_MAX}s (7 days).`
  return null
}

// Humanize a TTL for display (e.g. 3600 → "1h", 5400 → "1h30m").
export function formatTtl(ttl: number | null): string {
  if (ttl == null) return "—"
  if (ttl === 0) return "0"
  const d = Math.floor(ttl / 86400)
  const h = Math.floor((ttl % 86400) / 3600)
  const m = Math.floor((ttl % 3600) / 60)
  const s = ttl % 60
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (s) parts.push(`${s}s`)
  return parts.join("") || "0"
}

function stripDot(name: string): string {
  return name.replace(/\.$/, "")
}

// Decode the small set of XML entities Route 53 emits in values/names.
function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// ---- AWS Route 53 ----------------------------------------------------------

const R53_HOST = "route53.amazonaws.com"
const R53_BASE = "/2013-04-01"

function awsCreds(creds: Record<string, string>): AwsCreds {
  return { accessKeyId: creds.accessKeyId ?? "", secretAccessKey: creds.secretAccessKey ?? "", region: creds.region || undefined }
}

function awsErrorMessage(xml: string): string | null {
  return xml.match(/<Message>([^<]+)<\/Message>/)?.[1] ?? null
}

// Find the PUBLIC hosted-zone id for an apex (there can be a private zone of the
// same name; we only edit the public one). Returns the bare id, e.g. "Z123ABC".
async function awsZoneId(creds: AwsCreds, apex: string): Promise<{ id: string; error?: string }> {
  const r = await awsGet(creds, "route53", R53_HOST, `${R53_BASE}/hostedzonesbyname`, { dnsname: apex, maxitems: "10" })
  if (r.status !== 200) return { id: "", error: awsErrorMessage(r.body) || `Route 53 HTTP ${r.status}` }
  const want = stripDot(apex).toLowerCase()
  for (const block of r.body.split(/<HostedZone>/).slice(1)) {
    const name = block.match(/<Name>([^<]+)<\/Name>/)?.[1]
    if (!name || stripDot(name).toLowerCase() !== want) continue
    if (/<PrivateZone>true<\/PrivateZone>/.test(block)) continue // skip private zones
    const id = block.match(/<Id>([^<]+)<\/Id>/)?.[1]
    if (id) return { id: id.replace(/^\/hostedzone\//, "") }
  }
  return { id: "", error: `No public Route 53 hosted zone for ${want}.` }
}

function parseRoute53Records(xml: string): DnsRecord[] {
  const out: DnsRecord[] = []
  for (const block of xml.split(/<ResourceRecordSet>/).slice(1)) {
    const body = block.split("</ResourceRecordSet>")[0]
    const name = body.match(/<Name>([^<]*)<\/Name>/)?.[1]
    const type = body.match(/<Type>([^<]*)<\/Type>/)?.[1]
    if (!name || !type) continue
    const ttlRaw = body.match(/<TTL>(\d+)<\/TTL>/)?.[1]
    const isAlias = /<AliasTarget>/.test(body)
    const setId = body.match(/<SetIdentifier>([^<]*)<\/SetIdentifier>/)?.[1]
    const values = [...body.matchAll(/<Value>([\s\S]*?)<\/Value>/g)].map((m) => xmlUnescape(m[1]))
    let editable = true
    let reason: string | undefined
    if (isAlias) {
      editable = false
      reason = "alias"
    } else if (setId != null) {
      editable = false
      reason = "routing policy"
    } else if (ttlRaw == null) {
      editable = false
      reason = "no TTL"
    }
    const display = stripDot(xmlUnescape(name))
    out.push({
      key: `${display}|${type}|${setId ?? ""}`,
      name: display,
      type,
      ttl: ttlRaw != null ? Number(ttlRaw) : null,
      values: isAlias ? ["(alias)"] : values,
      editable,
      reason,
    })
  }
  return out
}

const route53: RecordProvider = {
  async listRecords(rawCreds, apex) {
    const creds = awsCreds(rawCreds)
    const zone = await awsZoneId(creds, apex)
    if (!zone.id) return { ok: false, zoneId: "", records: [], error: zone.error }
    const records: DnsRecord[] = []
    const query: Record<string, string> = { maxitems: "300" }
    // Paginate via NextRecordName/Type (StartRecord* on the follow-up call).
    for (;;) {
      const r = await awsGet(creds, "route53", R53_HOST, `${R53_BASE}/hostedzone/${zone.id}/rrset`, query)
      if (r.status !== 200) return { ok: false, zoneId: "", records: [], error: awsErrorMessage(r.body) || `Route 53 HTTP ${r.status}` }
      records.push(...parseRoute53Records(r.body))
      if (!/<IsTruncated>true<\/IsTruncated>/.test(r.body)) break
      const nextName = r.body.match(/<NextRecordName>([^<]+)<\/NextRecordName>/)?.[1]
      const nextType = r.body.match(/<NextRecordType>([^<]+)<\/NextRecordType>/)?.[1]
      if (!nextName || !nextType) break
      query.name = nextName
      query.type = nextType
    }
    return { ok: true, zoneId: zone.id, records }
  },

  async setTtl(rawCreds, zoneId, record, ttl) {
    const creds = awsCreds(rawCreds)
    // UPSERT replaces the whole record set, so echo the existing values back with
    // the new TTL — anything omitted would be dropped.
    const valuesXml = record.values.map((v) => `<ResourceRecord><Value>${xmlEscape(v)}</Value></ResourceRecord>`).join("")
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">` +
      `<ChangeBatch><Comment>spinup: set TTL to ${ttl}</Comment><Changes><Change>` +
      `<Action>UPSERT</Action><ResourceRecordSet>` +
      `<Name>${xmlEscape(record.name)}</Name><Type>${record.type}</Type><TTL>${ttl}</TTL>` +
      `<ResourceRecords>${valuesXml}</ResourceRecords>` +
      `</ResourceRecordSet></Change></Changes></ChangeBatch>` +
      `</ChangeResourceRecordSetsRequest>`
    const r = await awsPost(creds, "route53", R53_HOST, `${R53_BASE}/hostedzone/${zoneId}/rrset/`, body)
    if (r.status !== 200) return { ok: false, error: awsErrorMessage(r.body) || `Route 53 HTTP ${r.status}` }
    const changeId = r.body.match(/<Id>([^<]+)<\/Id>/)?.[1]?.replace(/^\/change\//, "")
    return { ok: true, pollId: changeId }
  },

  async pollChange(rawCreds, pollId) {
    const creds = awsCreds(rawCreds)
    const r = await awsGet(creds, "route53", R53_HOST, `${R53_BASE}/change/${pollId}`)
    if (r.status !== 200) return "failed"
    return /<Status>INSYNC<\/Status>/.test(r.body) ? "done" : "pending"
  },
}

// ---- Cloudflare ------------------------------------------------------------

const CF_API = "https://api.cloudflare.com/client/v4"

function cfHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

function cfError(json: { errors?: { message?: string }[] } | undefined, status: number): string {
  return json?.errors?.[0]?.message || `HTTP ${status}`
}

async function cfZoneId(token: string, apex: string): Promise<{ id: string; error?: string }> {
  const res = await fetch(`${CF_API}/zones?name=${encodeURIComponent(apex)}`, { headers: cfHeaders(token) })
  const json = (await res.json().catch(() => undefined)) as { success?: boolean; result?: { id: string }[]; errors?: { message?: string }[] } | undefined
  if (!res.ok || !json?.success) return { id: "", error: cfError(json, res.status) }
  const id = json.result?.[0]?.id
  return id ? { id } : { id: "", error: `No Cloudflare zone for ${apex}.` }
}

const cloudflare: RecordProvider = {
  async listRecords(rawCreds, apex) {
    const token = rawCreds.token ?? ""
    const zone = await cfZoneId(token, apex)
    if (!zone.id) return { ok: false, zoneId: "", records: [], error: zone.error }
    const records: DnsRecord[] = []
    let page = 1
    let totalPages = 1
    do {
      const res = await fetch(`${CF_API}/zones/${zone.id}/dns_records?per_page=100&page=${page}`, { headers: cfHeaders(token) })
      const json = (await res.json().catch(() => undefined)) as
        | { success?: boolean; errors?: { message?: string }[]; result?: { id: string; type: string; name: string; content: string; ttl: number; proxied?: boolean }[]; result_info?: { total_pages?: number } }
        | undefined
      if (!res.ok || !json?.success) return { ok: false, zoneId: "", records: [], error: cfError(json, res.status) }
      for (const r of json.result ?? []) {
        const proxied = r.proxied === true
        records.push({
          key: r.id,
          recordId: r.id,
          name: stripDot(r.name),
          type: r.type,
          ttl: r.ttl === 1 ? null : r.ttl, // 1 = Cloudflare "automatic"
          values: [r.content],
          editable: !proxied,
          reason: proxied ? "proxied" : undefined,
        })
      }
      totalPages = json.result_info?.total_pages ?? 1
      page++
    } while (page <= totalPages)
    return { ok: true, zoneId: zone.id, records }
  },

  async setTtl(rawCreds, zoneId, record, ttl) {
    const token = rawCreds.token ?? ""
    if (!record.recordId) return { ok: false, error: "Missing Cloudflare record id." }
    const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${record.recordId}`, {
      method: "PATCH",
      headers: cfHeaders(token),
      body: JSON.stringify({ ttl }),
    })
    const json = (await res.json().catch(() => undefined)) as { success?: boolean; errors?: { message?: string }[] } | undefined
    if (!res.ok || !json?.success) return { ok: false, error: cfError(json, res.status) }
    return { ok: true } // Cloudflare applies synchronously
  },
}

// ---- Registry --------------------------------------------------------------

const RECORD_PROVIDERS: Partial<Record<ConnProvider, RecordProvider>> = {
  aws: route53,
  cloudflare,
}

// The record provider for a connection provider, or null when records aren't
// API-editable for it (e.g. GoDaddy → web handoff).
export function recordProviderFor(provider: ConnProvider): RecordProvider | null {
  return RECORD_PROVIDERS[provider] ?? null
}

// The TTL the picker should show as "current" for a record whose live TTL is null
// (Cloudflare auto): default the custom field to a sensible 1h starting point.
export function defaultTtlFor(record: DnsRecord): number {
  return record.ttl ?? 3600
}

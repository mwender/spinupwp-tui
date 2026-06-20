// Hand-rolled AWS Signature Version 4 for GET requests — no `aws` CLI, no SDK.
// We only ever issue a handful of read-only GETs (STS GetCallerIdentity, Route 53
// ListHostedZones / ListResourceRecordSets), so the full SigV4 algorithm for an
// unsigned-body GET is all we need. Keeps the app dependency-light (node:crypto +
// fetch only) and the compiled binary small.
//
// Reference: docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
// Verified against AWS's published "get-vanilla" test vector (see awsSigV4.test).

import { createHash, createHmac } from "node:crypto"

export interface AwsCreds {
  accessKeyId: string
  secretAccessKey: string
  region?: string // defaults to us-east-1 (Route 53 + STS are global, signed in us-east-1)
  sessionToken?: string
}

function sha256hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex")
}
function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest()
}

// AWS URI-encoding (RFC 3986): encodeURIComponent plus the four chars it leaves.
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
}

export interface SignGetOptions {
  creds: AwsCreds
  service: string
  host: string
  path: string // already in canonical form (we only use simple ASCII paths)
  query?: Record<string, string>
  amzDate?: string // override for testing; defaults to now in ISO8601 basic (YYYYMMDDTHHMMSSZ)
}

// Produce the headers + URL for a signed GET. Pure (no I/O) so it can be unit
// tested against AWS's reference vectors.
export function signGetV4(opts: SignGetOptions): { url: string; headers: Record<string, string> } {
  const { creds, service, host, path } = opts
  const region = creds.region || "us-east-1"
  const query = opts.query ?? {}
  const amzDate = opts.amzDate ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
  const dateStamp = amzDate.slice(0, 8)

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join("&")

  // Signed headers (lowercase names, sorted). host + x-amz-date, plus the session
  // token header when present.
  const hdrs: Record<string, string> = { host, "x-amz-date": amzDate }
  if (creds.sessionToken) hdrs["x-amz-security-token"] = creds.sessionToken
  const names = Object.keys(hdrs).sort()
  const canonicalHeaders = names.map((n) => `${n}:${hdrs[n].trim()}\n`).join("")
  const signedHeaders = names.join(";")

  const payloadHash = sha256hex("") // empty body for a GET
  const canonicalRequest = ["GET", path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n")

  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n")

  const kDate = hmac("AWS4" + creds.secretAccessKey, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex")

  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  // host is implied by the URL (fetch sets it); send the rest.
  const headers: Record<string, string> = { "x-amz-date": amzDate, Authorization: authorization }
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken

  const url = `https://${host}${path}${canonicalQuery ? "?" + canonicalQuery : ""}`
  return { url, headers }
}

// Sign and perform a GET. Returns the HTTP status + raw body text.
export async function awsGet(
  creds: AwsCreds,
  service: string,
  host: string,
  path: string,
  query: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const { url, headers } = signGetV4({ creds, service, host, path, query })
  const res = await fetch(url, { method: "GET", headers })
  return { status: res.status, body: await res.text() }
}

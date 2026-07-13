// HTTPS handoff helpers for the server-clone wizard. Certificate bodies and private
// keys deliberately travel only in the returned object: callers must not attach this
// object to CloneLogger, job state, errors, or toast messages.

import { sudoExec, type SudoCtx } from "./serverClone.ts"

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type TlsCertificateKind = "letsencrypt" | "custom"

export interface TlsMaterial {
  certificate: string
  privateKey: string
  fingerprint: string
  kind: TlsCertificateKind
}

export interface TlsProbe {
  ok: boolean
  fingerprint?: string
}

function b64(value: string): string | null {
  try {
    return Buffer.from(value, "base64").toString("utf8")
  } catch {
    return null
  }
}

function openssl(args: string[], input: string): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(["openssl", ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    proc.stdin.write(input)
    return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([stdout, code]) => ({ ok: code === 0, stdout }))
  } catch {
    return Promise.resolve({ ok: false, stdout: "" })
  }
}

async function certificateFacts(certificate: string): Promise<{ fingerprint: string; isLetsEncrypt: boolean; sans: string[] } | null> {
  const result = await openssl(["x509", "-noout", "-fingerprint", "-sha256", "-issuer", "-ext", "subjectAltName"], certificate)
  if (!result.ok) return null
  const fingerprint = result.stdout.match(/SHA256 Fingerprint=([0-9A-F:]+)/i)?.[1]?.replace(/:/g, "").toLowerCase()
  if (!fingerprint) return null
  return { fingerprint, isLetsEncrypt: /let'?s encrypt/i.test(result.stdout), sans: Array.from(result.stdout.matchAll(/DNS:([^,\s]+)/g), (m) => m[1]!.toLowerCase()) }
}

// Locates the active certificate from the server's Nginx configuration. The command
// emits only base64 PEM data on stdout; stderr is intentionally ignored by callers so
// a failed lookup never leaks config paths into the UI/log.
export function activeTlsLookupScript(domain: string): string {
  return [
    "set -euo pipefail",
    `DOMAIN=${shq(domain)}`,
    "CONF=",
    "for D in /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d; do",
    '  [ -d "$D" ] || continue',
    '  for F in "$D"/*; do',
    '    [ -f "$F" ] || continue',
    '    if grep -Eq "server_name[^;]*[[:space:]]${DOMAIN//./\\\\.}([[:space:];])" "$F"; then CONF="$F"; break 2; fi',
    "  done",
    "done",
    '[ -n "$CONF" ] || exit 41',
    "CERT=$(sed -n -E 's/^[[:space:]]*ssl_certificate[[:space:]]+([^;]+);.*/\\1/p' \"$CONF\" | head -n1)",
    "KEY=$(sed -n -E 's/^[[:space:]]*ssl_certificate_key[[:space:]]+([^;]+);.*/\\1/p' \"$CONF\" | head -n1)",
    '[ -n "$CERT" ] && [ -n "$KEY" ] && [ -r "$CERT" ] && [ -r "$KEY" ] || exit 42',
    'printf "CERT=%s\\nKEY=%s\\nPATH=%s\\n" "$(base64 -w0 \"$CERT\")" "$(base64 -w0 \"$KEY\")" "$CERT"',
  ].join("\n")
}

export async function readActiveTlsMaterial(ctx: SudoCtx, domain: string, domains: string[] = [domain]): Promise<{ ok: true; material: TlsMaterial } | { ok: false; error: string }> {
  const script = activeTlsLookupScript(domain)
  const res = await sudoExec(ctx.server, ctx.sudoUser, ctx.sudoPassword, script, 45_000)
  if (!res.ok) return { ok: false, error: "couldn't read the active HTTPS certificate on the source" }
  const cert64 = res.stdout.match(/^CERT=(.+)$/m)?.[1]
  const key64 = res.stdout.match(/^KEY=(.+)$/m)?.[1]
  const path = res.stdout.match(/^PATH=(.+)$/m)?.[1] ?? ""
  const certificate = cert64 ? b64(cert64) : null
  const privateKey = key64 ? b64(key64) : null
  if (!certificate?.includes("BEGIN CERTIFICATE") || !privateKey?.includes("PRIVATE KEY")) return { ok: false, error: "source HTTPS certificate was invalid" }
  const facts = await certificateFacts(certificate)
  if (!facts) return { ok: false, error: "source HTTPS certificate could not be validated" }
  const covers = (name: string) => facts.sans.some((san) => san === name || (san.startsWith("*.") && name.endsWith(san.slice(1))))
  if (domains.some((name) => !covers(name.toLowerCase()))) return { ok: false, error: "source HTTPS certificate does not cover every cloned domain" }
  return { ok: true, material: { certificate, privateKey, fingerprint: facts.fingerprint, kind: path.startsWith("/etc/letsencrypt/") || facts.isLetsEncrypt ? "letsencrypt" : "custom" } }
}

// Probe the destination from the destination host itself. SNI is explicit, so this
// verifies the intended vhost even though public DNS still points at the source.
export async function probeDestinationTls(ctx: SudoCtx, domain: string, ip: string): Promise<TlsProbe> {
  if (!ip) return { ok: false }
  const script = [
    "set -o pipefail",
    `DOMAIN=${shq(domain)}`,
    `IP=${shq(ip)}`,
    'FP=$(timeout 20 bash -c "echo | openssl s_client -connect $IP:443 -servername $DOMAIN 2>/dev/null | openssl x509 -noout -fingerprint -sha256" 2>/dev/null || true)',
    'curl -fsS --resolve "$DOMAIN:443:$IP" "https://$DOMAIN/" -o /dev/null --max-time 20 >/dev/null 2>&1 || exit 43',
    'printf "%s\\n" "$FP"',
  ].join("\n")
  const res = await sudoExec(ctx.server, ctx.sudoUser, ctx.sudoPassword, script, 45_000)
  const fingerprint = res.stdout.match(/SHA256 Fingerprint=([0-9A-F:]+)/i)?.[1]?.replace(/:/g, "").toLowerCase()
  return { ok: res.ok && !!fingerprint, fingerprint }
}

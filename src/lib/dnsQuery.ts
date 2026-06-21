// Minimal DNS query over UDP (node:dgram) — no `dig`, no deps. It exists to get
// the one thing node's resolver can't: the TTL of ANY record type (notably CNAME)
// as CONFIGURED. We query a zone's AUTHORITATIVE nameserver directly, so the answer
// carries the full, non-decremented TTL (a recursive resolver hands back a
// counted-down value, which is misleading for a migration). Same hand-rolled
// spirit as awsSigV4.ts — we implement just enough of the protocol.
//
// Scope: A / AAAA / CNAME rdata are parsed for real (the website-hosting records
// the DNS inventory shows); MX / TXT are parsed for display; anything else returns
// its type + TTL with a placeholder value. Name compression pointers are handled.

import { createSocket } from "node:dgram"
import { isIP } from "node:net"
import { Resolver } from "node:dns/promises"

export interface DnsAnswer {
  name: string
  type: string // "A" | "AAAA" | "CNAME" | "MX" | "TXT" | numeric string
  ttl: number
  value: string
}

export type QueryType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS"

const TYPE_NUM: Record<QueryType, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 }
const NUM_TYPE: Record<number, string> = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 15: "MX", 16: "TXT", 28: "AAAA" }
const TIMEOUT_MS = 4000

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".").filter(Boolean)
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, "ascii")
    return Buffer.concat([Buffer.from([b.length]), b])
  })
  return Buffer.concat([...bufs, Buffer.from([0])])
}

function buildQuery(name: string, type: number): { id: number; buf: Buffer } {
  const id = Math.floor(Math.random() * 65536)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2) // standard query, recursion desired
  header.writeUInt16BE(1, 4) // QDCOUNT = 1
  const tail = Buffer.alloc(4)
  tail.writeUInt16BE(type, 0)
  tail.writeUInt16BE(1, 2) // QCLASS = IN
  return { id, buf: Buffer.concat([header, encodeName(name), tail]) }
}

// Read a (possibly compressed) name starting at `offset`. `next` is where reading
// continues AFTER the name in the original stream (compression pointers don't
// advance it past the 2-byte pointer).
function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = []
  let i = offset
  let jumped = false
  let next = offset
  let guard = 0
  while (guard++ < 128) {
    const len = buf[i]
    if (len === 0) {
      i++
      if (!jumped) next = i
      break
    }
    if ((len & 0xc0) === 0xc0) {
      const ptr = ((len & 0x3f) << 8) | buf[i + 1]
      if (!jumped) next = i + 2
      i = ptr
      jumped = true
      continue
    }
    labels.push(buf.toString("ascii", i + 1, i + 1 + len))
    i += 1 + len
  }
  return { name: labels.join("."), next }
}

function parseAnswers(buf: Buffer): DnsAnswer[] {
  const qd = buf.readUInt16BE(4)
  const an = buf.readUInt16BE(6)
  let off = 12
  for (let q = 0; q < qd; q++) {
    const r = readName(buf, off)
    off = r.next + 4 // skip QTYPE + QCLASS
  }
  const answers: DnsAnswer[] = []
  for (let a = 0; a < an && off < buf.length; a++) {
    const r = readName(buf, off)
    off = r.next
    const type = buf.readUInt16BE(off)
    off += 2 // TYPE
    off += 2 // CLASS
    const ttl = buf.readUInt32BE(off)
    off += 4
    const rdlen = buf.readUInt16BE(off)
    off += 2
    const rdStart = off
    let value = ""
    if (type === 1 && rdlen === 4) {
      value = `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`
    } else if (type === 28 && rdlen === 16) {
      const segs: string[] = []
      for (let k = 0; k < 16; k += 2) segs.push(buf.readUInt16BE(off + k).toString(16))
      value = segs.join(":")
    } else if (type === 5) {
      value = readName(buf, off).name
    } else if (type === 15) {
      value = `${buf.readUInt16BE(off)} ${readName(buf, off + 2).name}`
    } else if (type === 16) {
      let p = off
      const chunks: string[] = []
      while (p < off + rdlen) {
        const l = buf[p]
        chunks.push(buf.toString("ascii", p + 1, p + 1 + l))
        p += 1 + l
      }
      value = chunks.join("")
    } else {
      value = `(${rdlen}b)`
    }
    off = rdStart + rdlen
    answers.push({ name: r.name, type: NUM_TYPE[type] ?? String(type), ttl, value })
  }
  return answers
}

// Resolve a nameserver hostname to an IP (via public resolvers), or pass an IP
// through unchanged.
async function nsIp(nsHost: string): Promise<string | null> {
  if (isIP(nsHost)) return nsHost
  try {
    const r = new Resolver({ timeout: TIMEOUT_MS, tries: 1 })
    r.setServers(["1.1.1.1", "8.8.8.8"])
    const a = await r.resolve4(nsHost)
    return a[0] ?? null
  } catch {
    return null
  }
}

function queryOnce(serverIp: string, host: string, type: number): Promise<DnsAnswer[]> {
  return new Promise((resolve, reject) => {
    const { id, buf } = buildQuery(host, type)
    const sock = createSocket(isIP(serverIp) === 6 ? "udp6" : "udp4")
    const done = (err: Error | null, ans?: DnsAnswer[]) => {
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        /* already closed */
      }
      err ? reject(err) : resolve(ans!)
    }
    const timer = setTimeout(() => done(new Error("DNS query timed out")), TIMEOUT_MS)
    sock.on("message", (msg) => {
      if (msg.length < 12 || msg.readUInt16BE(0) !== id) return done(new Error("DNS id mismatch"))
      try {
        done(null, parseAnswers(msg))
      } catch (e) {
        done(e as Error)
      }
    })
    sock.on("error", (e) => done(e))
    sock.send(buf, 53, serverIp)
  })
}

// Query a record at the zone's authoritative nameservers (first that answers).
// Returns the full answer section (a CNAME chain may include several records), or
// null when none of the nameservers respond.
export async function queryAuthoritative(host: string, type: QueryType, nameservers: string[]): Promise<DnsAnswer[] | null> {
  for (const ns of nameservers) {
    const ip = await nsIp(ns)
    if (!ip) continue
    const ans = await queryOnce(ip, host, TYPE_NUM[type]).catch(() => null)
    if (ans) return ans
  }
  return null
}

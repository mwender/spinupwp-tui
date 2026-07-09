# DNS hosts, access & editing

A **server-migration lens** for DNS: see the records that move a site to another
server, and edit them in place. It is deliberately **not** a full zone editor — it
only ever shows and touches a site's own hosting records (its apex / `www` /
subdomains and additional domains), so your MX, TXT, DKIM, and other zone records are
never shown or changed. Moving a site can't take down its email.

- **The view.** Press `n` on a site for just that site's records, or `N` on a server
  for every site on it; inside a site-scoped view, `a` expands to the whole server.
  Each **site** is a line, labeled by its own domain (even when it's a subdomain),
  with its hosting record's type, **TTL in seconds**, value, a `◀ here` flag when the
  record points at this server, and a `+www` tag when `www` simply follows the apex.
  A site's additional domains nest beneath it, so a domain portfolio reads as one
  site, not many. TTLs come from the zone's authoritative nameserver (the configured
  value, not a counted-down one), so they show even for hosts you haven't connected;
  `r` refreshes.
- **Access (`✓ ↗ ○ ·`).** Each record's zone shows whether you can edit it: `✓`
  editable, `↗` web-only handoff, `○` the provider has an API but you haven't
  connected an account that holds the zone, `·` unknown. A zone is `✓` only when a
  connected account of the provider that actually serves it (its live nameservers)
  holds it — so a stale or duplicate zone elsewhere never shows a false green. With
  two or more accounts connected, an **ACCOUNT** column names the owning one.
- **Edit a TTL (`⏎`).** On an editable record, `⏎` opens a focused editor — pick a
  preset or a custom value, confirm, and it's written to **AWS Route 53** or
  **Cloudflare** through your connected account. This is the prep step for a low-risk
  migration: lower the TTL, cut over, then restore it. Before writing, an edit-time
  check re-reads the live nameservers and **blocks** the change if the connected
  account's zone isn't the one actually serving the domain. Route 53 changes are
  followed to completion; the record shows an "updating" status that keeps ticking
  even if you leave the view. Cloudflare **proxied** records keep their TTL fixed
  to automatic, so it's not editable here — repointing still works (next).
- **Repoint a record (`p`).** The same focused editor, on the record's **value** —
  where it points. The picker leads with **your SpinupWP servers** (name + IP, the
  record's current home tagged), because pointing a record at one of your own boxes
  is what this is for; a custom IP is the fallback. The same confirm and NS
  pre-flight gate apply, the write is followed to completion in the background, and
  the inventory row shows `→ new IP` while it applies. A Cloudflare **proxied**
  record repoints its **origin** behind the proxy (visitors keep resolving
  Cloudflare's IPs). CNAMEs aren't repointed — they follow their target, which is
  the record to edit. This is the standalone version of the clone wizard's DNS
  cutover: migrate a single site, finish a cutover by hand, or fix a stale record.
- **Connect a provider (`c`).** Manage credentials for the selected zone's
  provider — **AWS Route 53** (an IAM access key), **Cloudflare** (a scoped token),
  or **GoDaddy** (a Production API key). Multiple accounts per provider are
  supported, with a drill-down into each account's zones. Credentials are verified
  before they're stored, kept in `config.json` (chmod 600), and the matching
  environment variables are honored (`CLOUDFLARE_API_TOKEN`, `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`, `GODADDY_API_KEY` / `GODADDY_API_SECRET`). Secrets are
  masked as you type. Listing hosts needs only read access (Cloudflare `Zone:Read`);
  **editing (a TTL or a repoint)** needs write access — Route 53 record writes, or a
  Cloudflare `Zone.DNS:Edit` token.
- **Web-only hosts (GoDaddy, Namecheap, Network Solutions, …).** A registrar with
  no usable API shows `↗`; press `w` (in the inventory or the connect overlay) to
  open its web console — for GoDaddy specifically, your Clients hub, with the
  domain copied to your clipboard so you can paste it after logging in as the
  client. Every `↗` zone also shows an **access note** — "Delegate Access" by
  default (the assumed-normal case for a client's registrar), or your own
  per-zone override (e.g. an IT vendor's contact) when that default doesn't hold.
  Press `c` on any such zone to open **Manage Access**: it lists every zone
  already known at that host, `n` edits the selected zone's note, and `r`
  resolves your whole fleet's DNS to fill in any zones it hasn't seen yet.

Provider credentials are optional — without them you still get the full host
inventory and TTLs, just without the editable/account columns or in-place editing.

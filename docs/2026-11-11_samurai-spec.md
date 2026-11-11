# Samurai, to-dos and the Report Browser — spec

Promoted from `docs/2026-10-15_ideas.md` (idea 1's Samurai section) on 2026-11-11, after a conversation that reshaped it. Samurai was conceived as Sentinel's reactive arm: Sentinel sees abuse, Samurai proposes a ban over Beacon. It now starts somewhere safer and more useful: **the to-dos Sentinel's reports already recommend.** That needs two things Samurai doesn't own (a to-do list and a Report Browser), so this spec covers all three. Fourth module against `docs/2026-10-16_beacon-and-module-contract-spec.md`.

**Status: approved 2026-11-11.** All seven decisions at the end are approved.

**Naming (2026-11-11, during phase 1):** the list's items are **to-dos** (`spinuptui todos`, IDs like `T-41`, `todos.jsonl`), because "follow-up" was already Scheduler's word for a check that runs later. A Sentinel repeat within 6 hours, which the Sentinel spec called a follow-up, is now an **update**. Reports keep their `## Follow-ups` heading.

## What it is for

**Outcome framing:** Sentinel tells you what broke and what to do about it. To-dos make sure what it told you doesn't get lost, and that Sentinel remembers what you decided. Samurai does the parts of it that are nginx rules for you, after you've seen exactly what it will change.

Three pieces, each useful without the next:

1. **The to-do list** (Sentinel): every recommendation in a report becomes an item with an ID, a kind, a scope and a state. Sentinel reads it before every diagnosis.
2. **The Report Browser** (TUI): read reports, work the to-dos, mark them done, won't fix or snoozed, and comment.
3. **Samurai v1** (module): on an nginx to-do, press `f`, see the rule and its rollback, confirm, and it ships through the gated nginx deploy and is verified from outside.

## What the reports taught us

Sentinel has been live since 2026-11-03. The workspace holds 223 incident reports. The ones written in the 8 days since go-live contain 72 to-do bullets.

| Observation | What it decides |
|---|---|
| The same recommendation recurs across reports: a missed-beat tolerance on the `fatal` push monitor appears in at least five, "10 of this server's 13 sites are unmonitored" in four, a premium-plugin license decision in four | A to-do belongs to a site, server or the fleet, not to a report. Reports reference it |
| Agents already carry items forward by hand ("Still open from the 2026-10-06 report on …") | The agent wants this context; give it the ledger instead of making it reread old reports |
| Some agents already use `- [ ]` / `- [x]` | A checklist is the natural shape |
| Some bullets aren't to-dos: "I added this event to SITE.md", "I didn't run the first-hop test" | Items need a kind for notes, which are recorded but never open |
| Only 6 of 72 mention nginx; the largest group by far is Kuma monitoring (missing monitors, beat tolerance), then plugin and theme decisions, server ops (swap, sysstat, `pm.max_children`) and Sentinel/SpinupTUI tuning | The ledger and browser are worth building for their own sake. Samurai is one consumer, and its first version is narrow |
| The canonical nginx example (a small site, 2026-11-08: deny `/wp-admin/includes/*.php` and `/wp-config-sample.php`) is on a Cloudflare-proxied site, logged from Cloudflare edge IPs, and the site isn't onboarded to nginx-deploy | Path rules first, IP rules only after real-IP is fixed, and onboarding is a real prerequisite (see Samurai) |

## Scope

**In this round:**

- The to-do list, its format, and how the diagnosis and to-do prompts read and write it.
- A structured to-dos block in the agent's answer, parsed by Sentinel.
- The Report Browser: a new top-level tab.
- `spinuptui todos …` CLI equivalents.
- Samurai v1: operator-initiated nginx fixes from a to-do, from a fixed set of rule templates.
- Guided setup: preparing one site at a time for Samurai from inside SpinupTUI, with nginx-deploy's gate folded in (decisions 6 and 7).
- The Cloudflare real-IP template, as the prerequisite for any IP-based rule on a proxied site.

**Not in this round:**

- **Reactive defense** (Sentinel spots abuse live, Samurai proposes over Beacon). That's v2, with the Approve / Refine / Ignore buttons already decided on 2026-10-29.
- **IP bans and anything with an expiry** (proposed decision 4). Both need unattended writes to remove them, which v1 avoids entirely.
- **Fleet-scale application.** Off the table for this release (Michael, 2026-11-11). v1 works one site at a time.
- **Setting up many sites at once.** Guided setup is per site and operator-started; nothing installs the gate on a server unasked.
- **Fixes other than nginx.** The proposal format is generic so they can be added (see "Beyond nginx"), but v1 ships one handler.
- **Cloudflare WAF as a target.** Picking the right layer stays part of the product, later.
- **Under-attack mode and `limit_req`.** A `limit_req_zone` lives in `http {}`, which on SpinupWP means the shared `before/` include where zone names can collide between sites on one box. It needs its own design.

## The to-do list

### The item

A to-do is the result of its events, so this is what the TUI and CLI show, not what's stored (see "Storage"):

```json
{
  "id": "T-41",
  "kind": "nginx",
  "scope": { "type": "site", "domain": "example.com" },
  "title": "Deny direct requests to wp-admin/includes/*.php and wp-config-sample.php",
  "detail": "Scanners run core files directly; each one is a fatal and a page.",
  "fix": { "template": "deny-paths", "params": { "paths": ["~ ^/wp-admin/includes/.*\\.php$", "= /wp-config-sample.php"], "status": 403 } },
  "state": "open",
  "reports": ["sites/example.com/incidents/2026-11-08-scanner-get-locale-fatal.md"],
  "comments": [{ "at": "2026-11-11T15:02:00Z", "by": "operator@macbook", "text": "Do this before the next scan." }]
}
```

- **`kind`:** `nginx`, `monitoring`, `plugin` (plugin, theme or core code), `server` (OS, PHP-FPM, Redis, swap), `sentinel` (tuning Sentinel or SpinupTUI itself), `decision` (needs the operator's call, e.g. a license), `watch` (check again if it recurs), `note` (something the agent did; recorded, never open).
- **`scope`:** `site` (a domain), `server` (its vanity host, the same folder name the workspace already uses) or `fleet`.
- **`state`:** `open`, `done`, `wontfix`, `snoozed` (with an `until` date, after which it reads as open again). `note` items are created `done`.
- **`fix`:** optional, and only for kinds a handler exists for. In v1 that's `nginx` with one of Samurai's templates. Its presence is what makes `f` available in the browser.
- **IDs are short and sequential** (`T-41`), so they can be typed in a CLI or, later, a Telegram reply. **Only Sentinel on the station creates items**, which is already true because only Sentinel writes reports, so counters can't collide between machines. Any machine can comment on or change the state of an existing item.

### Storage: an append-only event log

`~/SpinupTUI/sentinel/todos.jsonl`, next to `expectations.json`, whatever `sentinel.workspace` points to (decision 2). That's consistent with Sentinel's decision 5, and it means the log is committed and pushed by the home flow. The diagnostics workspace gitignores `sites/`, so a ledger kept there would have no backup.

One JSON event per line, never edited or removed:

```
{"v":1,"at":"2026-11-08T13:40:00Z","by":"sentinel","id":"T-41","event":"created","kind":"nginx","scope":"site:example.com","title":"…","fix":{…},"report":"sites/example.com/incidents/2026-11-08-scanner-get-locale-fatal.md"}
{"v":1,"at":"2026-11-11T15:02:00Z","by":"operator@macbook","id":"T-41","event":"comment","text":"Do this before the next scan."}
{"v":1,"at":"2026-11-12T09:10:00Z","by":"operator@macbook","id":"T-41","event":"done","text":"Samurai proposal P-3, verified"}
```

- **Events:** `created`, `report` (attached to another report, from `still-open`), `comment`, `done`, `wontfix`, `snoozed` (with `until`), `reopened`, `regressed`, `fix-applied` and `fix-rolled-back` (with the Samurai proposal ID). Each carries a schema version `v`, so the format can change without rewriting history.
- **The current state is a fold** over the events in timestamp order. At the expected volume, about 3,000 items a year and a few MB of events, that takes milliseconds, so there's no snapshot or cache to keep in step.
- **Writes only append**, one line, under `flock.ts`'s lock, so the worker, TUI, CLI and later the Beacon listener can't interleave. A crash can at worst leave a torn last line, which the reader skips and reports. Nothing already written can be damaged.
- **git merges it.** The home repository gets `todos.jsonl merge=union` in `.gitattributes`, so appends from the MacBook and the station merge without a conflict. Order comes from `at`, not from line order, so a merge that interleaves lines changes nothing.
- **When two machines act on one item while apart** (say one marks it done and the other comments), both events survive and the later state event wins. Two conflicting state changes are rare enough to just show, as a line in the item's history, rather than design around.
- **It stays plain text**, readable with `cat` and `jq`, like everything else Sentinel and Scheduler keep.

**Why not a database.** Considered and declined on 2026-11-11. A server database (Postgres and the like) is a service to install, upgrade and back up on every station, against the installed-weight pitch. SQLite (`bun:sqlite`, no dependency) was the real alternative: it gives transactions and indexes, but the volume doesn't need them, and a SQLite file in the home repository is an opaque binary that changes on every write, can't be reviewed and can't be merged between machines. **Rule from here on: files are the source of truth, and SQLite is allowed only as an index or cache that can be deleted and rebuilt from them.** The likely first use is Samurai v2's counting of rule hits and request rates from access logs. Revisit the ledger itself if it reaches tens of thousands of events a year, several stations write it, or the browser needs joins across months.

### How Sentinel writes it

The agent's answer gains one fenced block after the report, which Sentinel parses and strips before saving the report:

````
```todos
[
  { "ref": "new", "kind": "nginx", "scope": "site:example.com", "title": "…", "detail": "…", "fix": { "template": "deny-paths", "params": { … } } },
  { "ref": "T-12", "event": "still-open", "text": "Third page in three days that a 2-miss tolerance would have absorbed." },
  { "ref": "T-7", "event": "regressed", "text": "Marked done 11-04, but the same fatal is back." },
  { "ref": "new", "kind": "note", "scope": "server:web1.example.com", "title": "Added SITE.md for web1" }
]
```
````

- **`new`** creates an item. Sentinel assigns the ID and links the report.
- **`still-open`** adds the report to an existing item and appends the agent's text as a comment. This replaces "Still open from the 2026-10-06 report" prose.
- **`regressed`** reopens a `done` item with the agent's evidence and pages, since a fix that didn't hold is news. Reopening is the only state change an agent may make. It never closes, won't-fixes or snoozes anything: that's the operator's call.
- **The report's Markdown Follow-ups section stays**, written for a person, with each bullet tagged by its ID (`[T-41]`), so a report read anywhere still makes sense.
- **A block that doesn't parse doesn't fail the diagnosis.** The report is saved as it always was, the page says the to-dos weren't recorded, and `spinuptui todos import <report>` retries.
- **A `fix` that doesn't validate against its template's schema is dropped**, and the item is created without one. The operator can still do the work by hand. Samurai never sees an unvalidated fix.

### How Sentinel reads it

Before every diagnosis and to-do, the prompt gains a section listing the ledger items for the incident's site, its server and the fleet: open, snoozed, and anything closed in the last 30 days, each with its state, title and the operator's latest comment. The prompt's rules gain:

- Reference an existing item by ID rather than writing a new one for the same thing.
- Don't recommend something the operator marked `wontfix`. If the evidence now argues for it, say so once, as a comment on that item, and say what changed.
- A `done` item whose problem is back is `regressed`, with the evidence.
- The operator's comments are the operator's words. Everything else in the ledger came from earlier agent runs and is a hypothesis, like an earlier report.

The list is capped (newest first, 40 items) so a noisy server can't crowd the prompt.

### Back-fill

The 223 existing reports have no IDs. Proposed (decision 3): import only the reports written since go-live (2026-11-03), with one agent run that reads them and emits a single `todos` block, which the operator reviews in the browser before it's committed to the ledger. Older reports stay readable in the browser, but their to-dos aren't tracked.

## The Report Browser

A new top-level tab, `7 Reports`, beside Modules. It has two lists, toggled with `Tab`:

**Reports:** newest first: date, site, monitor kind, a one-line summary (the report's SUMMARY, kept by the incident record), and how many of its to-dos are still open. `Enter` shows the report in the right pane. `o` opens the file in `$EDITOR` or the system viewer.

**To-dos:** open items, grouped by scope (fleet, then server, then site), filterable by kind and state. The right pane shows the item's detail, every report it appears in, and its history. Keys:

| Key | Action |
|---|---|
| `d` | Done, with an optional comment |
| `w` | Won't fix, with a required reason, since Sentinel will read it |
| `s` | Snooze until a date |
| `c` | Comment |
| `r` | Reopen |
| `f` | Fix with Samurai: only on an item with a valid `fix`, on an onboarded site |
| `Enter` | Jump to the newest report it appears in |

The tab teaches itself in context: the legend shows only the keys that apply to the selected item, and `f` on an item without a handler explains why it isn't available, e.g. "example.com isn't set up for nginx deploys yet".

Other places it surfaces, cheaply:

- A site's details show its open to-do count, and `Enter` on it jumps to the browser filtered to that site.
- The daily digest replaces its "To-dos" section with ledger counts and the items that changed state.
- The CLI: `spinuptui todos list [--site d] [--state open]`, `show <id>`, `done|wontfix|snooze|comment|reopen <id> …`, and `import <report>`. JSON on stdout, like the other headless commands.

A Beacon `/todos` command is natural once this exists, but is left for v2 with the rest of the pager work.

## Samurai v1

### The flow

1. In the browser, on an nginx item with a `fix`, the operator presses `f`.
2. Samurai checks the site is eligible (below), runs the mirror's `pull`, and stops if `pull` brings drift: it's committed as its own "Sync from server" commit first, as the nginx-deploy skill requires.
3. It renders the template into Samurai's file in the mirror and shows a confirm overlay: the exact diff, the file it goes in, the rollback, and how it will be verified. This is the confirm-before-firing pattern from `PhpUpgrade.tsx`.
4. On confirm, it commits (`Samurai: T-41 deny direct core-file requests`), runs `test`, then `push`. The gate runs `nginx -t`, reloads, and restores the previous files by itself if anything fails.
5. **It verifies from outside**, because `nginx -t` only proves the config parses: each denied path returns the expected status, and the site's home page still returns 200. A failed verification rolls back (step 7) and pages.
6. The item becomes `done`, with an event recording the commit, the proposal hash and the verification results. Every proposal is logged in `~/SpinupTUI/samurai/proposals/<id>.json`.
7. **Rollback** is a revert commit of that change, pushed the same way. It's available on the item in the browser (`u` on a Samurai-fixed item) and as `spinuptui samurai rollback <proposal>`.

The CLI equivalent is `spinuptui samurai propose <todo-id>`, which prints the proposal and exits, then `samurai apply <proposal-id> --hash <hash>`, which applies exactly that version. Applying re-checks that the mirror and the server still match what the proposal was built against, so a proposal can't be applied to a site that changed underneath it. That's the same property the Beacon buttons will need in v2.

### Templates, not free-form nginx

Every rule Samurai writes is one of a fixed set of reviewed templates with typed parameters (proposed decision 5). An agent's job, when one is involved, is choosing a template and its parameters, never writing nginx. A template owns its validation, its rendering, its verification and a comment header tagging each rule with its to-do ID, so its hits can later be counted in the access log.

v1's set:

| Template | Renders | Verified by |
|---|---|---|
| `deny-paths` | `location` blocks (exact, prefix or a regex limited to a safe subset) returning 403, 404 or 444 | Each path returns that status; `/` returns 200 |
| `gone-paths` | `return 410` for an URL space: the calendar crawler trap, generalized | A sample URL returns 410 |
| `block-user-agent` | A match on the user agent returning 403 or 444, refusing any pattern that matches a verified good bot's UA | A request with that UA is refused; one with a normal browser UA isn't |
| `cloudflare-real-ip` | `set_real_ip_from` for each published Cloudflare range, plus `real_ip_header CF-Connecting-IP` | Proposed only for a proxied site; afterwards new access-log lines show non-Cloudflare client IPs |

IP bans (`ban-ip`, with mandatory expiry) are v2.

### Where the rules go

All of Samurai's rules for a site go in one file, `server/samurai.conf`, registered on the site's allowlist at onboarding. Two reasons:

- **No sudo per fix.** nginx-deploy needs a human with sudo to register a new file, but not to change an allowlisted one. One pre-registered file means every later fix ships without that step.
- **Order matters, and this file is in the right place.** SpinupWP's site file includes `server/*` before its own `location ~ \.php$` block (checked on a real mirror). nginx uses the first regex location that matches, in file order, so a regex deny in `server/samurai.conf` wins over PHP handling, which is what makes `deny-paths` work on `.php` files at all.

The file is regenerated from the ledger's applied fixes each time, never edited in place, so it always equals the set of applied items. A rule that's rolled back simply isn't rendered next time.

SpinupWP already ships `xmlrpc-protection.conf`, `uploads-directory-protection.conf` and HSTS in `https.conf`, so templates check the mirror for an existing equivalent and say so rather than adding a duplicate.

### Eligibility

A site is eligible when it has a Samurai mirror (below, or an existing nginx-deploy mirror, adopted), the gate on its server reports a compatible version, its allowlist includes `server/samurai.conf`, and `doctor` passes. Today that's no site: the two sites already on nginx-deploy have mirrors and gates, but neither allowlists `server/samurai.conf` yet. `f` on an ineligible site opens guided setup instead of failing.

### Guided setup

Decided 2026-11-11: guided setup is in v1, rather than leaving onboarding to `nginx-deploy-admin` by hand. This is where nginx-deploy's proof of concept moves into SpinupTUI (decision 7), because setup has to install the gate.

It runs from the site's details or from `f` on an ineligible item, one site at a time, and uses the server's saved sudo connection (`S`). Without one, it explains how to connect sudo and stops. Its steps, each shown before it runs:

1. **Check the server:** `nginx -V` (for `http_realip_module`), the include layout of the site file, and whether a gate is already installed and at what version.
2. **Install or upgrade the gate** (root, through sudo): the gate script, the `nginxdeploy` user, its sudoers line, and the backups directory. This is the one step that changes the server outside nginx's include dirs, so its confirm overlay lists every path it writes. Re-running it is safe, as `install.sh` is today.
3. **Generate this machine's deploy key** for the site and register it with the site's allowlist (`server/samurai.conf`, plus any existing custom files the operator keeps).
4. **Create the mirror** under `<configDir>/modules/samurai/mirrors/<domain>/`, a git repository of the site's live nginx config, committed as "Initial mirror of server config". It isn't inside the site's app repository, so it can't trigger Push-to-Deploy, and it isn't under `~/SpinupTUI`, where a nested repository would become a gitlink in the home repository. It needs no backup of its own: the server holds the live config, and `server/samurai.conf` is regenerated from the ledger. A site already on nginx-deploy keeps its existing mirror, adopted by path.
5. **Prove it:** `doctor`, then an empty `server/samurai.conf` pushed through the gate, `nginx -t`, and an outside check that the site still returns 200.

Setup is reversible: `spinuptui samurai remove <domain>` empties `server/samurai.conf` through the gate, then removes the site's key and allowlist. Removing the gate from a server is a separate, explicit command, refused while any site on that server still uses it.

Hazards it must handle:

- **The gate is root-owned code, run on every push.** The version SpinupTUI installs is the version it ships, checked by hash at install and by `version` before each push. A gate that differs from what SpinupTUI expects stops Samurai on that server until setup is re-run.
- **Two sites on one server share the gate**, but not keys: a key serves one site, as nginx-deploy enforces today.
- **The two existing nginx-deploy sites** are migrated, not re-onboarded: setup detects the existing gate, upgrades it in place if needed, and adds `server/samurai.conf` to their allowlists.

### Sites behind Cloudflare

Agreed in conversation on 2026-11-11:

- **Path and user-agent rules work the same on proxied and unproxied sites.** They're all of v1 except `cloudflare-real-ip`.
- **No IP-based rule is ever proposed for a proxied site until `cloudflare-real-ip` is applied there.** Otherwise a ban hits a Cloudflare edge and blocks real visitors. The DNS module knows which sites are proxied.
- **Samurai proposes `cloudflare-real-ip` itself**, as a to-do, when Sentinel's evidence shows only Cloudflare IPs in a site's log. It's worth having on its own: Sentinel's reports then show real client IPs.
- **Cloudflare's ranges change occasionally.** The template records the list it rendered and the date. A weekly check in the digest compares it against Cloudflare's published list (`/ips-v4`, `/ips-v6`) and opens a to-do to re-render when it differs.
- `http_realip_module` is compiled into SpinupWP's nginx (checked 2026-11-11 on one server with `nginx -V`, nginx 1.30.3). The geoip modules aren't, so country or ASN rules would have to go to Cloudflare. Samurai re-checks `nginx -V` on each server before its first push there.

### Beyond nginx

Michael asked whether Samurai should grow beyond nginx. Yes, under one rule: **a fix handler must provide an exact preview, a rollback, a check that the target still matches what the proposal assumed, and an outside verification.** Anything that can't do all four isn't a Samurai fix; it stays a to-do a person does.

The proposal format is generic for that reason: `{ id, todoId, handler, target, change, preview, rollback, precondition, verify, hash }`. Candidates that meet the bar, roughly in order of how cleanly they do:

- SpinupWP site settings through the API (PHP limits, page cache, HTTPS): the API returns the current value, so preview and rollback are exact.
- Plugin and theme updates through wp-cli, reusing the `u` flow's version pinning, with rollback to the recorded version.
- Kuma monitor changes (the largest group of to-dos): add a monitor, set a beat tolerance. SpinupTUI already writes to Kuma.
- `wp option` changes, with the old value recorded.

Each is its own handler and its own change.

## Module shape

Samurai joins `src/modules/` like the others: a `summary` for the Modules screen and landing page, `status()` (eligible sites, applied rules, the last proposal and its result), and no Scheduler jobs in v1, since nothing runs unattended. The ledger and the browser belong to Sentinel, which owns the reports.

| Where | What |
|---|---|
| `~/SpinupTUI/sentinel/todos.jsonl` | The ledger (event log) |
| `~/SpinupTUI/samurai/proposals/` | Every proposal, applied or not, with its hash, diff and verification |
| `<configDir>/modules/samurai/` | Machine-level settings and the mirror map |

## Build order

Each phase is useful alone and can ship as its own `1.4.0-alpha.N` on npm's `next` tag:

1. **Ledger and structured to-dos.** Prompt changes, parser, event log, fold and lock, the home repository's `.gitattributes`, the CLI, the digest section. Run it live for a few days to see whether agents use IDs and the block reliably before anything is built on it.
2. **Report Browser.** The tab, both lists, the state actions, the site-details count. Then the back-fill.
3. **Samurai v1.** The folded-in gate and guided setup first, then templates, propose/apply/rollback, verification and the `f` key. Tested first against nginx-deploy's sandbox, then live on wp.spinuptui.com (set up from scratch), then on one of the two existing nginx-deploy sites (migrated).

## Testing

- The parser against the real answers from the last week, plus malformed blocks, unknown IDs and a `fix` that fails its schema.
- Ledger concurrency: the worker appends while the TUI appends; a torn last line; two clones that both append, merged with `merge=union`, fold to the same state.
- Each template's renderer against golden files, and its validator against hostile parameters: a regex that would match `/`, a UA pattern matching Googlebot, a path with a newline or `;`.
- Samurai end to end against nginx-deploy's own sandbox (`test/run.sh` mocks the gate and `nginx -t`), then live on wp.spinuptui.com, including a forced verification failure to prove the rollback.
- Visual: the browser in Dev Mode fixtures, which gain a few reports and a ledger.

## Open questions

- **Folding in nginx-deploy (decision 7).** It's the proof of concept and stays private. Its gate, `install.sh` and client move into SpinupTUI in phase 3, with guided setup. Open: whether the gate keeps its name and paths (`/usr/local/sbin/spinupwp-nginx-deploy`), which makes migrating the two existing sites trivial, or is renamed for Samurai.
- **Server- and fleet-scope fixes.** nginx-deploy is per site, and some to-dos are box-wide, such as one server's box-wide scanner deny in `before/`. v1 handles site scope only.
- **Rule hygiene.** The tag in each rule's header makes hits countable. A digest line for rules that haven't fired in 30 days is a small addition once there are enough rules to matter.
- **Where Sentinel's reports should live long-term.** The diagnostics workspace has no backup for `sites/`. Moving it into the private home repository was already noted as Sentinel's decision 4's cost.

## Decisions

All seven approved on 2026-11-11.

1. **Build in three phases** (ledger, browser, Samurai), each an alpha on `next`, with stable 1.4.0 once Samurai v1 is in. **Approved 2026-11-11.**
2. **The ledger is an append-only event log, `~/SpinupTUI/sentinel/todos.jsonl`**, not in the workspace, so it's backed up, merged with `merge=union`, and never a database. SQLite only as a rebuildable index or cache. **Approved 2026-11-11.**
3. **Back-fill only reports since go-live (2026-11-03)**, through one reviewed agent run. **Approved 2026-11-11.**
4. **Samurai v1 makes no unattended writes:** no IP bans and no expiries. Every change is operator-initiated and confirmed. **Approved 2026-11-11.**
5. **Templates only.** Samurai never writes free-form nginx, in v1 or later. A new template is code in SpinupTUI (parameter schema, validator, renderer, verification), added in a development session through the normal branch, PR and release. The digest counts nginx to-dos that no template covers, so new templates follow real demand, and operator-written rules still deploy through the gate in the operator's own allowlisted file, which Samurai never touches. Operator-loadable templates under `~/SpinupTUI/samurai/` stay a later option. **Approved 2026-11-11.**
6. **Guided setup is in v1:** one site at a time, operator-started, through the server's saved sudo connection, installing the folded-in gate (see "Guided setup"). **Approved 2026-11-11** (Michael chose this over the proposed manual onboarding).
7. **Before stable 1.4.0, the gate becomes public by folding nginx-deploy into SpinupTUI.** nginx-deploy is the proof of concept Samurai grows from, not a dependency it keeps: its gate, install script and client move into SpinupTUI, and a public user installs one thing. **Approved 2026-11-11.**

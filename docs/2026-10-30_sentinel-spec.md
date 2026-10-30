# Sentinel — spec

Promoted from `docs/2026-10-15_ideas.md` (idea 1's Sentinel section, idea 3's attach flow, idea 4's "one clock") on 2026-10-30. Third module against the contract in `docs/2026-10-16_beacon-and-module-contract-spec.md`, and the first to declare jobs for Scheduler (`docs/2026-10-20_scheduler-spec.md`). Ships as `1.3.0-alpha.5` on npm's `next` tag. Stable 1.3.0 follows once Sentinel is in, with the landing page.

**Status: approved 2026-10-30.** The seven decisions that shaped it are recorded at the end.

## What it is for

**Outcome framing: Sentinel watches the fleet, works out what actually broke, and writes it up.** Uptime monitoring tells you a domain is down. Sentinel tells you why, on your phone, with a report waiting by the time you look. It also notices the failures monitoring can't see: a crawler that stopped arriving, a cache that stopped hitting, a server that stopped updating.

**Underneath, it is three tiers, and each stands alone:**

1. **Detect** (deterministic, always on): diff Uptime Kuma's events against state every tick, group them into incidents, page.
2. **Triage** (deterministic): gather the evidence a person would look at first and save it as a write-up.
3. **Diagnose** (optional, bring your own agent CLI): an agent investigates read-only over `ssh-exec`, and its report replaces the bare write-up.

Without an agent CLI, a user still gets tiers 1 and 2, and the daily digest.

## What the existing automation taught us

Sentinel packages an incident watcher that has been running unattended since July. Its logs decided several things below, so they're recorded here.

| Measured from the existing watcher (Jul 14 to Oct 30) | Value | What it decides |
|---|---|---|
| Ticks / diagnosis runs | 8,635 / 170 | An agent runs on 2% of ticks, so the deterministic gate works |
| Diagnosis duration | median 3.8 min, p90 9.8, max 18.4; 14 over 10 min, 2 over 15 | Diagnosis can't run inside a module job (see below) |
| Diagnosis runs where every domain had already been seen in the last 1h / 6h / 24h | 31 / 76 / 109 of 170 | Recurrences need their own rule |
| One domain's share of all runs | 97 of 170 | The same |
| Runs involving one domain | 166 of 170 | Fleet-wide bursts are rare, so grouping is simple |
| Busiest day | 11 runs | Sets the daily cap |
| Time from event to detection at a 15-minute cadence | median 10 min, p90 30 | A faster tick is worth having |
| Monitors in Kuma / wired to Kuma's own Telegram alert | 84 / 42 | Kuma already pages for half the fleet |
| Last 14 daily digests headed "needs attention" | 13 | Flags that repeat daily stop being read |

The narrative lessons carry over too, each of which cost something real:

- **A lapsed agent login silently stopped every diagnosis for eight days.** Detection kept advancing past events nobody diagnosed.
- **`Edit` permission doesn't imply `Write`, and every report is a new file.** A missing allow rule stopped reports being saved for two and a half months.
- **A tick straight after wake races the network.** The incidents check needs a retry before it declares the watcher blind.
- **A self-healer that works silently hides the thing it heals.** Log how often it intervenes.
- **`spinuptui siblings` is what finds the real cause.** The paging domain is routinely not the causing domain.

## Scope

**In this round:**

- `sentinel.tick` and `sentinel.digest` as Scheduler module jobs.
- The incident model: grouping, recurrence, a daily diagnosis cap, and at-least-once diagnosis.
- A diagnosis worker that runs outside the tick, using Scheduler's agent adapters.
- Write-ups on disk, and a Basecamp transport for posting them to the operator's own team board.
- The digest and expectation checks, replacing the existing per-type config files.
- `sentinel attach`, so a fresh install can adopt an existing Kuma's monitors.
- Sentinel on the Modules screen, its `status()`, and `/incidents` on the pager.
- The Scheduler and Beacon changes this depends on, including `blocked` and Run again.
- A cutover with a shadow period, written so nothing is missed or paged twice.

**Not in this round:**

- **Client-facing posts** (decision 6). The rule stands: templated or reviewed text only, confirm-gated, idempotent per template, subject and thread. The transport built here is what it will use.
- **Kuma bootstrap** (idea 3). Sentinel needs a Kuma; it doesn't build one yet.
- **Before/after measurement** ("compare the next 24h with the previous 24h"). The trend CSV and a Scheduler follow-up cover the need for now.
- **Samurai's input.** Sentinel's incident records will feed it, but no proposal path is built.
- **More than one account.** See "Open questions".
- **The two remaining one-off automations** (a 410 verifier and a client follow-up). They become Scheduler jobs or an expectation later, each in its own change.

## The shape of it

```
Scheduler's dispatcher (every 5 min)
  └─ sentinel.tick   seconds; Kuma diff → incidents → page → start worker if needed
  └─ sentinel.digest once a day

sentinel worker      minutes; detached, one at a time; agent → report → post → page
Beacon listener      resident; /incidents, Diagnose anyway, Run again
```

### Why diagnosis can't run inside the tick

Doing it the way the old watcher does (the tick blocks on the agent) fails against Scheduler on three counts:

1. **Module jobs are killed at 10 minutes.** That would have killed 14 of the last 170 diagnoses.
2. **Ticks are exclusive and jobs run one at a time.** While one diagnosis runs, no second incident is detected and no follow-up runs.
3. **The heartbeat is sent at the end of a tick, and a tick that finds the lock held exits without pinging.** The station monitor allows 15 minutes, so a long diagnosis would make Kuma report a healthy station as dead. Two of the 170 would have.

So the tick stays fast, and anything slow goes to a worker the tick starts. This keeps "one clock": the worker isn't a scheduled unit, runs only when a tick starts it, and exits when its queue is empty.

The third problem exists today for any long agent follow-up, so it's fixed in Scheduler regardless (see "Changes to Scheduler and Beacon").

## The tick

`spinuptui sentinel tick` is declared as `{ id: "sentinel.tick", every: "5m", command: ["sentinel", "tick"] }`. A clean tick takes about 4 seconds today, and the old cadence of 15 minutes was only ever a launchd default. (Decision 3.)

1. **If paused, record and stop.** Events are still read and marked as seen, so resuming doesn't page for a window the operator deliberately silenced.
2. **Read events** with `resolveIncidents`, for the window since the last fully clean tick (at least 1 hour, at most 168). Retry on failure: 3 attempts, 60 seconds apart, as the old watcher does. A recovery is logged and counted, and the digest shows that count, so a machine that keeps waking cold can't hide behind the retry.
3. **If still failing, exit non-zero.** Scheduler already pages when a module job starts failing and again when it recovers. That is how "the watcher is blind" reaches the operator, with no second alert path to maintain. This is also what watches Kuma: Kuma watches the station through the heartbeat, and the tick watches Kuma.
4. **Take new events** by a seen-set, not a timestamp comparison (below).
5. **Group them into incidents, page, and queue diagnosis.**
6. **Check for finished or stale work:** close incidents, requeue crashed ones, retry blocked ones that are due.
7. **Start the worker** if anything is queued and no worker holds the lock.

### Seen-set, not high-water mark

The old watcher keeps one timestamp and moves it to the newest event it saw. That has two faults this spec removes:

- **Events can be lost for good.** `resolveIncidents` swallows a failure to read one monitor (it returns no beats for it). If another monitor's newer event moves the timestamp in that tick, the failed monitor's event is permanently behind the mark.
- **The mark moves before the work is done.** That is why a lapsed login lost eight days of incidents rather than delaying them.

Sentinel keeps a set of `(monitor, time)` keys for 8 days. `resolveIncidents` gains a `failedMonitors` list. A tick with any failed monitor isn't "clean", so the next tick's window still covers it, and the seen-set stops anything being handled twice. Marking an event as seen and creating its incident are one atomic state write, and diagnosis tracks its own progress in the incident, so nothing depends on the agent succeeding.

## Incidents

An incident is the unit of work: one thing went wrong, however many monitors noticed.

### Grouping

- **Group by server.** New down events on the same server, in the same tick or joining an open incident, are one incident. The fleet map (domain → server) comes from the SpinupWP API, is cached in the state directory, and refreshes at each digest and whenever an unknown domain appears. A domain that isn't in the fleet is its own incident.
- **An incident closes** once every monitor in it has come back up and 30 minutes have passed with no new down event.
- **A new event joining an open incident pages once, silently, per domain,** and doesn't start a second diagnosis. If the report already exists, the event is appended to the incident record and shown in the digest.

### Recurrence

Before queuing diagnosis, the tick looks for a report covering the same domain and monitor kind from the last 6 hours (`sentinel.recurrenceHours`). If there is one, the event is recorded as a **recurrence**: no agent runs, and a silent page says so, naming the earlier report, with a **Diagnose anyway** button.

Up to 76 of the last 170 runs fit this rule. That's an upper bound, because a repeat can have a new cause, which is why the button exists and why it stays visible: the digest shows each site's recurrence count, and the third recurrence in 24 hours pages with sound. (Decision 2.)

This doesn't suppress anything Kuma sends. It decides only whether an agent spends time on it.

### The daily cap

At most `sentinel.maxDiagnosesPerDay` (default 15) diagnosis runs start per day. The busiest day so far had 11. Past the cap, incidents stay queued, one page says so, and the digest lists them. It guards against a monitoring fault turning into a bill.

### Lifecycle

```
open → queued → diagnosing → reported
                    │
                    ├→ waiting_agent   login lapsed; pages once, retries every 30 min
                    ├→ blocked         the agent couldn't do the work; Run again
                    └→ failed          after 2 attempts; Run again
open → recurrence   no diagnosis; Diagnose anyway
```

Each incident is one JSON file in `<stateDir>/incidents/`, replaced atomically, so the worker, the tick and the listener never share a mutable file. A closed incident stays for 30 days.

**Nothing waits silently.** Every non-final state appears in `status()`, `/incidents` and the digest. An incident stuck behind a lapsed login is a queue with a page attached, not a silent gap: when the login comes back, the queue drains oldest first. An incident that has waited more than 24 hours is diagnosed with a note that its evidence may have aged out.

## Paging

Every page goes through `beaconSend`, in-process, plain text, to Beacon's default channel or `sentinel.channel`.

| Moment | Page | Sound |
|---|---|---|
| New incident | 🔴 domains, monitor kinds, server, "diagnosing" or "no agent configured" | Silent if Kuma already paged for it |
| Joined an open incident | Domain and kind | Silent |
| Recurrence | The earlier report, **Diagnose anyway** | Silent; sound on the third in 24h |
| Report ready | 🧾 the summary, the root cause, the report's location | Yes |
| Blocked or failed | Why, **Run again** | Yes |
| Agent login lapsed | Which agent, the exact fix, how many incidents are waiting | Yes, once |
| Daily cap reached | How many are waiting | Yes, once |
| Watcher blind | Scheduler's change-only page | Yes |

**One alert or two.** Kuma's own notification is the raw, fast "it's down", and it doesn't depend on the station. Sentinel's is the triaged "here's why". The first Sentinel page used to duplicate Kuma's. Kuma's monitor list carries `notificationIDList`, so the tick knows when Kuma has already paged, and sends its "diagnosing" page silently in that case. For monitors with no Kuma alert, Sentinel's page is the first anyone hears, so it makes a sound.

A recovery doesn't page. Kuma does that where it's wired, and the digest counts it.

## Triage

Triage is deterministic, needs no agent, and runs at the start of each incident. It produces an `Evidence` section:

- The events, with kinds, times and messages.
- The server: name, size, Ubuntu version, and its sites, flagging the vanity host and which are monitored (`resolveSiblings` without `--probe`).
- `runSiteDoctor` for each affected domain: HTTP status, cache state, template fingerprint, verdict.
- A short read-only load snapshot over `ssh-exec` on the affected domain, if it's reachable.

**Triage never uses `siblings --probe`.** A probe makes one SSH attempt per co-tenant, and a co-tenant without the station's key fails it. Servers here run fail2ban, and an automated run of failed attempts on every incident would eventually ban the station. The agent may use `--probe`, sparingly, when the symptom points at the server, which is what the old watcher allows.

Without an agent, this evidence under a templated heading is the write-up. With one, it's handed to the agent as a starting point, so the agent doesn't repeat those commands.

## Diagnosis

Enabled by `sentinel.diagnosis.agent` (`claude` or `codex`). Off means triage only.

### The worker

The tick starts `spinuptui sentinel worker` with Scheduler's own Bun and entry point (`selfCommand()`), as a detached process in its own session, **with stdin, stdout and stderr ignored**. If it inherited the job's stdout pipe, `runProcess` would wait for the pipe to close and the tick would block on the worker anyway.

The worker takes `<stateDir>/worker.lock`, handles queued incidents oldest first, and exits when the queue is empty. A diagnosis is killed after `sentinel.diagnosis.timeoutMin` (default 30; the longest so far was 18.4). If the worker crashes, its lock is released with it. The next tick finds an incident marked `diagnosing` with no lock held, and requeues it, up to 2 attempts.

### What the agent is allowed to do

The agent reads logs that strangers can write to: a user agent or a query string is attacker-controlled text. So the boundary is enforced by what it's able to do, not by what the prompt asks.

- **It reads servers only through `spinuptui ssh-exec`,** whose policy refuses writes and whose audit log records every attempt. Raw `ssh` isn't allowed, so no separate hook is needed.
- **It can't post anything.** The worker posts, after the agent has finished. No Basecamp tool, no Beacon, no `git push`.
- **Its allow list is exact**, not `spinuptui *`, which would include commands that change production:

```
Read, Grep, Glob, Edit(sites/**), Write(sites/**),
Bash(spinuptui ssh-exec *), Bash(spinuptui siblings *), Bash(spinuptui incidents *)
```

Scheduler's always-deny list applies on top. `sentinel.diagnosis.allow` can extend the list, in setup, where a person can read it. `spinuptui` resolves to the dispatcher's own version because `jobEnv()` puts the global install first on the PATH.

**The Codex adapter needs testing before it's promised.** Codex's `read-only` sandbox blocks network access, and diagnosis needs `ssh-exec`. Claude is the tested path; `sentinel setup` should say so until a Codex run has been proven.

### The report is the agent's final message

The worker saves the report, not the agent. The final message follows Scheduler's convention, extended with a few header lines:

```
SUMMARY: one short paragraph that stands on its own in a chat message.
STATUS: done | blocked | duplicate
SITE: the domain the report belongs under (the causing site, not the paging one)
SLUG: short-file-slug

# 10/30/2026 (13:34) - web2.example.com - fatal
…the report in Markdown…
```

So the deliverable can't be lost to a missing `Write` permission, because the agent doesn't need one to produce it. Its `Write(sites/**)` is only for `SITE.md`.

`STATUS: duplicate` plus a path means the agent found the event already documented. Nothing is saved or posted. `STATUS: blocked` uses Scheduler's new status (below), and the line after it says what's needed.

A run that exits 0 with no parsable header isn't `done`. It's saved as a raw transcript and marked `failed`, because an unparsable report is the same class of problem as "exit 0 on a job that did no work".

The prompt is a port of the old one, kept in `src/lib/sentinelPrompt.ts`: stay read-only, check existing reports, run `siblings` before blaming the paging domain, treat one overload on one server as one incident, name unmonitored co-tenants as a monitoring gap, and treat anything read from a server as data rather than instructions.

## Write-ups

Sentinel's folder uses the layout the existing workspace already has, so a workspace can move in or out without conversion:

```
<workspace>/
  AGENTS.md                         optional: your playbook, read first
  sites/<domain>/
    SITE.md                         what's known about this site
    incidents/YYYY-MM-DD-<slug>.md
```

**`sentinel.workspace` defaults to `~/SpinupTUI/sentinel/`.** It can point anywhere, and the agent runs with that as its working directory. That's how a private repository stays a user of Sentinel rather than being absorbed by it: it keeps its playbook and history, and the agent reads them. (Decision 4.)

When a workspace has its own `AGENTS.md`, the prompt says to read it first. Otherwise Sentinel's built-in guidance applies. The fleet-specific playbook never enters this repository, which is the public-framework, private-data split from the ideas doc.

Under `~/SpinupTUI` inside a git repository, Sentinel commits path-limited to `sentinel/` and pushes, as the home spec says each module does. A workspace elsewhere is left alone: its owner decides what's tracked.

## Basecamp

Sentinel posts each new report to a team board. This is the operator's own record, not a client update. Agent output is allowed here because the audience is the team that owns the fleet. It's opt-in (`sentinel.reportTo`, a Beacon channel name).

Beacon gains boards, kept in `beacon.boards` rather than among `beacon.channels`, so a board can't be paged by accident:

```json
{ "board": { "type": "basecamp", "projectId": "…", "mention": "…", "audience": "team" } }
```

- **Reports become HTML here, not in the CLI.** The Markdown converter moves from the prior art into `src/lib/` as TypeScript. A CLI-side conversion once posted a whole report as literal `##` and `**`.
- **It posts through the `basecamp` CLI's `api post`,** so its login stays the CLI's business. That login lives in the Keychain, which a LaunchAgent can read. A failed check from a sandboxed shell proves nothing, so the digest's check runs under the dispatcher.
- **Posting is at most once.** Basecamp has no idempotency key, and a double post is worse than a missing one because the report is safe on disk. The incident records `posting` before the request and the message id after. If a retry finds `posting` with no id, it doesn't repost: it pages that the post's outcome is unknown.
- **A failed post isn't a failed incident.** The report exists, the page says the post failed, and `sentinel post <id>` retries.
- **`audience: "client"` is refused for now.** The field exists so the client channel can't be reached by accident, and adding it later is an additive change.

## The digest

`{ id: "sentinel.digest", at: "08:00", command: ["sentinel", "digest"] }`. It always sends, silently when nothing is new. It's still a heartbeat a human reads, and it's the only place a slow-moving problem gets said out loud.

```
⚠️ 1 new — Fri Oct 30

Station: ticking, heartbeat up · Agent: OK · Board: OK
Last 24h: 288 checks · 2 incidents · 1 report · 1 recurrence · 0 blind

New:
  example.com: crawler LOW — 893 yesterday (expected ≥8000)

Ongoing:
  example.net: warmer idle — 12 days

Server updates: 22 of 22 normal
```

**The header reacts only to what's new.** Thirteen of the last fourteen digests said "needs attention", mostly the same two flags, and a header that's always amber says nothing. A flag appears under **New** on the day it trips, and under **Ongoing** with its age after that. The header is ✅ unless something is new, a health check failed, or an incident is stuck, and only then does the digest make a sound. An ongoing flag is never hidden, and `sentinel expect ack <id>` moves it to a one-line count when the operator has decided it's fine.

**Health checks:** the dispatcher and heartbeat, the agent login (one trivial probe a day through the same adapter a diagnosis uses, bounded at 60 seconds), the board login, Beacon's listener, the blind and retry counts, and any monitored domain with no monitors left in Kuma.

**Budget.** A module job is killed at 10 minutes, so the digest gets 8. Checks run four at a time with a 30-second limit each. Anything unfinished reads "unverified", and a failing check never loses the digest.

## Expectations

Checks for what uptime monitoring can't see. They run with the digest, read-only through `ssh-exec`, and report on the previous full day, because at 08:00 today's log is only a few hours old.

They live in one file, `~/SpinupTUI/sentinel/expectations.json`, private to the operator and committed with their work. (Decision 5.)

```json
[
  { "id": "crawler-example", "type": "log-count", "domain": "example.com", "match": "SomeCrawler/1.1", "min": 6000,
    "label": "SomeCrawler (ad-tech)", "note": "baseline ~11,100/day" },
  { "id": "retired-tags", "type": "log-count", "domain": "example.org", "match": "/old_tax/", "trend": true },
  { "id": "load-example", "type": "load-shape", "domain": "example.org", "threshold": 8.0 },
  { "id": "cache-example", "type": "cache-hit", "domain": "example.net", "host": "www.example.net", "paths": ["/", "/?gbraid=probe"] },
  { "id": "warmer-example", "type": "warmer", "domain": "example.org", "logGlob": "~/files/cache-warm/logs/warm-*.log" },
  { "id": "gone-example", "type": "status", "url": "https://example.com/retired/", "expect": 410, "expires": "2027-01-31" }
]
```

| Type | Asserts | Flags |
|---|---|---|
| `log-count` | Occurrences of a string in yesterday's rotated log; `min` is optional | Below `min`. With `trend`, appends to `trends.csv` |
| `load-shape` | Replays yesterday's `sar`: the peak, samples over the threshold, the longest run | 3+ consecutive samples ("latched") |
| `cache-hit` | Requests each path twice on the box; the second must be a HIT | Anything but HIT |
| `warmer` | The newest warmer log's queued count | 0 queued ("idle") |
| `status` | A public URL's status code, by plain HTTP, no SSH | Any other code |

The hard-won details carry over from the existing checks. Commands avoid a bare `>` and multi-parameter URLs, which the `ssh-exec` policy reads as a redirect and a shell operator. `$(date)` is evaluated on the server. Each `ssh-exec` call has its stdin closed. A failed probe reads "unverified", never as a passing check or a flag. `cache-hit` is a probe rather than a log statistic on purpose: a caching fix usually changes when a plugin writes its log line, so counting that line reports a triumph either way.

`expires` is optional, and an expired check drops out with a note in that day's digest. Most checks exist because of one fix, so a check about a fix should say when it stops mattering.

**Server updates are automatic, not an expectation.** The freshness check (stale `update-success-stamp`, or `apt-daily` stuck in `activating`) applies to every server, so it shouldn't need a config line per server. The digest picks one site per server from the fleet map, preferring the last one that worked, and makes one attempt per server per day. A server with no reachable site reads "unverified". That's the fail2ban rule again.

**Commands.** `sentinel expect add` validates and writes the file, so an agent session can add a check right after shipping a fix without hand-editing JSON. `sentinel expect check <id>` runs one now.

## Attach

A fresh install connected to a Kuma full of monitors sees none of them, because `incidents` reads the local `kumaMonitors` registry. `sentinel attach --plan|--apply` is the flow from idea 3, and it's what makes a second station possible:

1. List Kuma's monitors and the fleet's sites.
2. **Exact matches** by the naming convention (`{domain}`, `{domain} load`, `{domain} redis`, `{domain} php-fatal`, `{domain} front page`, `{domain} cache-bypass`) attach automatically.
3. **Likely matches:** a hand-made monitor whose URL host is a fleet domain. `--plan` lists them; the TUI asks yes or no per monitor; `--apply` takes them only with `--include-likely`.
4. **Leftovers both ways:** sites with no monitor (the TUI offers the existing register action), and monitors matching no site (listed and ignored).
5. Write the registry and run one `incidents --all` to prove Sentinel sees the fleet.

**Attach is read-only toward Kuma and the servers.** It never creates, renames or edits a monitor, and it never generates a push token, because the server crons are already pushing to the existing ones. It's re-runnable and only fills gaps. Being a setup command, it may write `config.json`.

## Config and state

```json
{
  "sentinel": {
    "enabled": true,
    "mode": "live",
    "channel": null,
    "reportTo": "board",
    "workspace": "~/SpinupTUI/sentinel",
    "recurrenceHours": 6,
    "maxDiagnosesPerDay": 15,
    "diagnosis": { "agent": "claude", "model": null, "timeoutMin": 30, "allow": null }
  }
}
```

`config.json` holds the machine-level settings above, and nothing Sentinel writes while running. `not_configured` until `enabled` is set, so no jobs run before setup.

| Where | What |
|---|---|
| `<configDir>/modules/sentinel/` | `seen.json`, `incidents/`, `fleet.json`, `flags.json` (first-seen dates for New vs Ongoing), `worker.lock`, `tick.log`, `pause.json`, `shadow.log` |
| `~/SpinupTUI/sentinel/` | `sites/`, `expectations.json`, `trends.csv` |

## Commands

```
spinuptui sentinel setup [--plan | --apply] [--shadow]
spinuptui sentinel attach --plan | --apply [--include-likely]
spinuptui sentinel status [--json]
spinuptui sentinel tick [--dry-run]
spinuptui sentinel digest [--dry-run]
spinuptui sentinel list [--open] [--json]
spinuptui sentinel show <incident>
spinuptui sentinel diagnose <incident>
spinuptui sentinel post <incident>
spinuptui sentinel pause --for 2h
spinuptui sentinel resume
spinuptui sentinel go-live --since "YYYY-MM-DD HH:MM:SS"
spinuptui sentinel expect list | add | remove <id> | check <id> | ack <id>
spinuptui sentinel worker                    (started by the tick)
```

As with every module: one JSON result on stdout with `--json`, progress on stderr, `{ ok: false, reason, message, remedy? }` on failure.

`pause` requires `--for`, up to 7 days, so a pause can't be forgotten. The digest says it's paused, and the end of a pause pages once. Taking a site offline through SpinupTUI already opens a Kuma maintenance window, so that needs no pause.

**On the pager:** `/incidents` lists open and waiting incidents, with **Diagnose anyway** and **Run again** where they apply. Sentinel declares them in `commands` and `actions`, and Beacon knows nothing about them. A tap only marks the incident queued, and the next tick starts the worker, so a tap can't add permissions or run anything the tick wouldn't.

## Status

`status()` is cheap and sends nothing. It reports:

- **Watching:** how many domains and monitors, and whether the registry is empty (the remedy is `sentinel attach`).
- **Last tick:** its age and result, and the blind streak if any.
- **Queue:** open, queued, waiting on login, blocked, failed.
- **Agent:** which one, and whether the binary is on the PATH. It doesn't run a probe, which the digest does.
- **Beacon, and the board if configured.**
- **Mode:** live, paused until a time, or shadow.
- **Other accounts:** warns if another profile has monitors Sentinel isn't watching.

`degraded` for a failing tick, an incident stuck more than 24 hours, or a missing agent binary. The remedy names the command.

## The Modules screen

Sentinel moves from `UPCOMING_MODULES` to `MODULES`, with `dependsOn: ["beacon", "scheduler"]`. The detail pane shows the status checks and open incidents.

`⏎` opens guided setup, in the same overlay pattern as Beacon and Scheduler: confirm Kuma is connected, run attach, pick the agent (detected from the PATH, or none) and prove it with one probe, optionally connect a board, then confirm. `t` runs `sentinel digest --dry-run` and shows it. `p` pauses for 2 hours, and pressing it again resumes.

Setup ends the way Scheduler's install does, by proving it: one real tick, reported on screen.

## Changes to Scheduler and Beacon

Sentinel can't ship without these, and each is a separate commit.

**Scheduler**

- **A locked dispatcher tick still pings the heartbeat,** with `tick still running`, and records that in `last-tick.json`. The holder is alive, so the station is. This fixes the false "station down" for any long follow-up, not just Sentinel.
- **Export the agent adapter** (`buildCommand`, `AUTH_FAIL_RE`, `ALWAYS_DENY`) in a form that takes options rather than a `Job`, so the worker uses the same adapters and a new adapter serves both.
- **`blocked`**, as designed in `docs/2026-10-15_ideas.md` under "Blocked jobs and Run again". This spec settles what that left open: an agent ends with a line `STATUS: blocked`, and a script exits with **75** (`EX_TEMPFAIL`). The status appears everywhere a status does, and a one-shot isn't counted as done.
- **Run again** on failed and blocked pages and in `/jobs`.

**Beacon**

- **`beaconSend` takes buttons.** Replies already have them. With no listener installed, a page goes out without them, since nothing could receive the tap.
- **`storeButton` needs a lock.** Today only the listener writes `buttons.json`. Once the tick and the worker store buttons too, a read-modify-write can lose one. Its `takeButton` needs the same lock.
- **Boards** (`beacon add basecamp`), sending through the new converter, reachable only by a named post.

## Cutover from the existing watcher

**The hazards are a missed incident, a double page, and a double post.** The old watcher and Sentinel don't share a state format, so unlike Scheduler's cutover this one can't overlap harmlessly in live mode. It's done with a shadow period and a single clean handover.

**Shadow mode** (`sentinel.mode: "shadow"`) runs the real tick and digest logic. It pages nothing, runs no agent, posts nothing, and writes what it would have done to `shadow.log`.

**Order of operations:**

1. Publish `1.3.0-alpha.5` and install it globally with `@next`. Confirm the listener restarted on the new version and `scheduler status` is healthy.
2. `sentinel setup --apply --shadow`, with the diagnostics workspace as `sentinel.workspace`, and add the expectations by hand with `expect add` (three config lines today, which expand to about six checks).
3. **Shadow for at least 3 days,** through at least one real down event if the fleet provides one. Each morning, compare `sentinel digest --dry-run` with the old digest, and `shadow.log` with the old `run.log`: same events seen, sensible grouping. Check that every server's update line resolves.
4. **Hand over,** just after a morning digest, with nothing diagnosing (no `incidents-watch.sh` process alive):
   1. Boot out the watchdog first, or it will try to kick the watcher.
   2. Boot out the watcher and the daily digest. Their plists stay in place for rollback.
   3. In the workspace, remove the old prompt's posting step from `AGENTS.md`, and the `basecamp` and blanket `spinuptui *` allow rules from its `.claude/settings.json`. Project settings still apply in that directory, so if this is skipped the agent could post as well, and every report would appear twice.
   4. `sentinel go-live --since "<lastEventTime from the old state file>"`. It clears shadow mode and treats anything after that time as new. Everything before it was the old watcher's, and everything after it is Sentinel's, so there's no gap and no overlap.
5. **Prove it.** Induce a failure on a test site, with the operator's go-ahead: a page, a worker run, a report in the workspace, a board post, one of each. Then confirm the next morning's digest arrives.
6. **Soak for a week,** comparing `tick.log` and Beacon's `send.log`, then remove the old plists. The diagnostics repository keeps its reports, playbook and notes, and calls Sentinel like any other user.

**Rollback** at any point before step 6: `sentinel setup --apply --shadow`, write `lastEventTime` from `sentinel status --json` (the newest event Sentinel has handled) into the old state file, and run the old `watch-enable.sh`, which reinstalls all three units.

**Not touched:** the 410 verifier, the client follow-up, and the host watchers.

## Testing

- **Unit tests** (`bun test`): event grouping, the seen-set (including a failed monitor in the same tick as a newer event), recurrence, incident closing and the state machine, parsing the report header (including an unparsable one), digest New vs Ongoing, each expectation's command text and parsing, `ssh-exec` policy acceptance for every generated command, the attach match rules, and the at-most-once post logic.
- **Replay.** `sentinel tick --dry-run` against live Kuma, with no state written. Locally, not committed, run the grouping and recurrence code over the old watcher's 212 logged events and compare it with what the old watcher did.
- **Live, isolated**, as for Scheduler: a scratch `XDG_CONFIG_HOME` and `SPINUPTUI_HOME`, a devtest label, and a stub agent on the PATH that sleeps, succeeds, reports `blocked`, or fails like a lapsed login. Run it through a real launchd tick, and **confirm the worker survives the tick ending**. launchd reaps a job's own process group, and the worker's own session should escape that, but this has to be proven on the real scheduler, not from a shell. Hold the worker's lock and confirm a tick doesn't start a second one. Run a 16-minute stub and confirm the heartbeat stays up.
- **One real agent run** against a test site before step 4 of the cutover, proving the allow list is enough. A missing rule stalls silently in a headless run, which is the mistake that cost two and a half months.

## Open questions

- **More than one account.** Monitors are per account, the Kuma login is machine-level, and `ssh-exec` resolves through the active account. The first version watches the active account only, and `status()` warns if another has monitors. Iterating profiles means every lookup taking an account. It's worth doing when a real multi-account station exists.
- **Linux.** Everything here is plain subprocesses, but the worker's detachment and Keychain-backed `basecamp` login are only proven on macOS.
- **Report secrets.** Reports can quote logs. The prompt says to scrub credentials, but nothing enforces it, and a report in `~/SpinupTUI` is committed. A pattern scrub in the worker before saving is a cheap second layer, and worth doing if any report ever trips it.

## Decisions

All seven approved on 2026-10-30.

1. **Diagnosis runs in a worker outside the tick.** The numbers above leave little choice, and this is the largest departure from a plain tick and digest.
2. **Recurrence: 6 hours, no re-diagnosis, sound on the third in 24h.** It could have skipped up to 45% of past runs. The risk is a new cause in the window, and Diagnose anyway is the mitigation.
3. **`sentinel.tick` every 5 minutes,** up from 15. Kuma sees 288 logins a day instead of 96.
4. **Keep the existing diagnostics repository as the workspace,** rather than moving its 187 report files into `~/SpinupTUI/sentinel`. It's the smallest cutover. The known cost is that `sites/` stays gitignored there, so those reports have no backup. Moving them into the private home repository later would fix that.
5. **Expectations in `~/SpinupTUI/sentinel/expectations.json`,** not profile keys as the contract spec anticipated. They'd be versioned and backed up with the operator's work, and easy for an agent to add to. This supersedes the contract spec's plan, and the file isn't account-aware.
6. **The client channel moves out of this round.** The contract spec said it would be built with Sentinel, but the code shows Sentinel's actual posts go to the team's own board. The only client-facing automation today is a one-off templated follow-up, which isn't part of this cutover. Building the gate now means building it with no real user.
7. **`sentinel attach` is in this round.** Nothing on the current station needs it, but a landing page can't promise Sentinel to anyone with an existing Kuma without it.

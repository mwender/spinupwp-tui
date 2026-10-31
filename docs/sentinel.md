# Sentinel

Sentinel watches your fleet, works out what actually broke, and writes it up. Uptime monitoring tells you a domain is down. Sentinel tells you why, on your phone, with a report waiting when you look. It also notices what monitoring can't see: a crawler that stopped arriving, a cache that stopped hitting, a server that stopped updating.

It builds on [Beacon](beacon.md) for paging, [Scheduler](scheduler.md) for its clock, and [Uptime Kuma](uptime-kuma.md) for detection. It's a pre-release: `bun add -g spinuptui@next --no-cache`.

## Turn it on

In the app, go to the Modules tab (`6`), select Sentinel and press `⏎`. It shows what it would do, then applies when you press `y`. From a terminal:

```sh
spinuptui sentinel attach --plan    # which Kuma monitors it would adopt
spinuptui sentinel attach --apply
spinuptui sentinel setup --plan
spinuptui sentinel setup --apply
```

Setup needs a Beacon channel, Scheduler's dispatcher and a Kuma connection, and tells you which is missing. It ends with one real check of Kuma. The first check starts from now, so past events don't page you.

`attach` is read-only toward Kuma and your servers: it never creates or edits a monitor and never touches a push token. Exact name matches attach automatically. A hand-made monitor on one of your domains is listed as a likely match, and attached only with `--include-likely`.

## What happens when something goes down

1. **Every 5 minutes** Sentinel reads Kuma's events. Down events on the same server become one incident.
2. **You get a page right away.** It's silent when Kuma already paged you for those monitors, because Sentinel's job is the "why" that follows.
3. **It gathers the evidence:** the events, the server and its sites, an HTTP check of each affected domain, and a read-only look at the load.
4. **If you've set up an agent, it investigates,** read-only, through `ssh-exec`, and its report replaces the bare evidence.
5. **You get the summary,** and the report is saved under `sites/<domain>/incidents/`. With a board set up, it's posted there too.

Without an agent you still get the page, the evidence as a write-up, and the digest.

### Repeats

If a report in the last 6 hours (`sentinel.recurrenceHours`) already covers the same domain and monitor kind, no agent runs. You get a silent page naming the earlier report, with a **Diagnose anyway** button. The third repeat in 24 hours makes a sound, and the digest counts them by site. This never suppresses anything Kuma sends.

### When a diagnosis can't finish

Nothing waits silently. `/incidents` on the pager, `spinuptui sentinel list --open` and the digest all show what's queued, waiting or stuck.

| What happened | What Sentinel does |
|---|---|
| The agent's login lapsed | Pages once with the fix, retries every 30 minutes, and works through the queue when it's back |
| The agent couldn't do the work | Marks it `blocked`, says what's needed, offers **Run again** |
| It failed or timed out | Tries once more, then marks it `failed`, with **Run again** |
| The day's limit is reached (`sentinel.maxDiagnosesPerDay`, default 15) | Pages once; the rest wait |
| Kuma can't be read | Retries for two minutes, then Scheduler pages you once, and again on recovery |

A tap on the pager only queues the incident. It can't add permissions.

## What the agent can do

Claude Code is the tested agent. Codex's read-only sandbox blocks the network `ssh-exec` needs, so treat it as unproven.

The agent reads logs that strangers can write to, so its limits are enforced by what it's able to do, not by what it's told. It reads servers only through `spinuptui ssh-exec`, which refuses writes and logs every attempt. It can edit `sites/` in the workspace. It can't post anything, push, or run any other `spinuptui` command. Sentinel saves its final message as the report and does the posting itself. To allow more, set `sentinel.diagnosis.allow` in `config.json`.

## Your workspace

Write-ups live in `~/SpinupTUI/sentinel/`:

```
sites/<domain>/SITE.md
sites/<domain>/incidents/YYYY-MM-DD-<slug>.md
expectations.json
trends.csv
```

If that folder is in a git repository, Sentinel commits only its own folder and pushes, after each report and each digest. Reports can quote logs, so treat them as private.

To use an existing playbook, set `--workspace <dir>`. The agent works from there, and an `AGENTS.md` in it is read first. A workspace elsewhere is never committed for you.

## Post reports to a team board

```sh
spinuptui beacon add basecamp board --project <id> --mention "Your Name"
spinuptui sentinel setup --report-to board --apply
```

This is for your own team's record. Agent output is never sent to a client. If a post fails, the page says so and the report is safe on disk; retry with `spinuptui sentinel post <incident>`. A post is never retried automatically, because Basecamp can't tell a retry from a second post.

## The daily digest

At 08:00 Sentinel sends one message: station health, the last 24 hours, and your checks. It's silent unless something needs you. A flag appears under **New** on the day it trips and under **Ongoing**, with its age, after that. If you've decided a flag is fine, `spinuptui sentinel expect ack <id>` turns it into a count. Preview it any time with `t` on the Modules tab or `spinuptui sentinel digest --dry-run`.

Server updates are checked automatically: one site per server, one attempt per day.

## Expectations

Checks for failures uptime monitoring never sees. They run with the digest and report on the previous full day.

```sh
spinuptui sentinel expect add crawler --type log-count --domain example.com \
  --match "SomeCrawler/1.1" --min 6000 --label "SomeCrawler" --note "baseline ~11,000/day"
spinuptui sentinel expect check crawler
```

| Type | Options | Flags when |
|---|---|---|
| `log-count` | `--match`, `--min`, `--trend` | yesterday's count is below `--min`. `--trend` adds to `trends.csv` |
| `load-shape` | `--threshold` | load stayed over the threshold for 30 minutes or more |
| `cache-hit` | `--host`, `--paths /,/?one=param` | a path's second request isn't a cache HIT |
| `warmer` | `--log-glob` | the newest warmer log queued nothing |
| `status` | `--url`, `--expect 410` | the URL returns anything else |

`--expires YYYY-MM-DD` retires a check that exists because of one fix. A check that can't run reads "unverified", never a pass.

## Pausing

`p` on the Modules tab pauses for 2 hours, or use `spinuptui sentinel pause --for 4h`, up to `7d`. A pause always ends by itself. Events during it are noted and not acted on. Taking a site offline through SpinupTUI needs no pause: it already opens a Kuma maintenance window.

## One account at a time

Sentinel watches the active account. `status` warns if another account on the machine has monitors it isn't covering.

## Moving from your own watcher

Shadow mode runs the real logic and writes what it would have done to `shadow.log` in Sentinel's state folder, with no pages, agent runs or posts. Run it beside your old setup for a few days, then stop the old watcher and hand over at the exact point it stopped:

```sh
spinuptui sentinel setup --shadow --apply
# later, with the old watcher stopped:
spinuptui sentinel go-live --since "2026-10-30 13:34:05"
```

Events before that UTC time were the old watcher's, and events after it are Sentinel's.

## Commands

```
spinuptui sentinel status | list [--open] | show <incident>
spinuptui sentinel diagnose <incident> | post <incident>
spinuptui sentinel tick [--dry-run] | digest [--dry-run]
spinuptui sentinel pause --for <time> | resume
spinuptui sentinel expect list | add | check <id> | remove <id> | ack <id>
```

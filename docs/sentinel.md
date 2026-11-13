# Sentinel

Sentinel watches your fleet, works out what actually broke, and writes it up. Uptime monitoring tells you a domain is down. Sentinel tells you why, on your phone, with a report waiting when you look. It also notices what monitoring can't see: a crawler that stopped arriving, a cache that stopped hitting, a server that stopped updating.

It builds on [Beacon](beacon.md) for paging, [Scheduler](scheduler.md) for its clock, and [Uptime Kuma](uptime-kuma.md) for detection.

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
5. **You get the gist,** and the report is saved under `sites/<domain>/incidents/`. With a board set up, it's posted there too. Every report opens with two plain lines, **Problem** and **Fix**, and the page leads with them, so you can stop there unless you want the detail.

Without an agent you still get the page, the evidence as a write-up, and the digest.

### Repeats get an update, not a new report

If the same domain and monitor kind went down in the last 6 hours (`sentinel.recurrenceHours`), the repeat is an **update**. The agent gets the earlier report, checks what's different this time, and says whether the earlier conclusion still holds. Its answer is added to that report under a dated `## Update` heading, so a problem that keeps coming back stays one report. On a team board it's a comment on the original post.

A second look is worth it: a problem an hour later is often still unfolding, and the second run can find what the first couldn't. The page for a repeat is silent, and the third in 24 hours makes a sound. Updates count toward the daily limit, and the digest counts them by site. This never suppresses anything Kuma sends.

### When a diagnosis can't finish

Nothing waits silently. `/incidents` on the pager, `spinuptui sentinel list --open` and the digest all show what's queued, waiting or stuck.

| What happened | What Sentinel does |
|---|---|
| The agent's login lapsed | Pages once with the fix, retries every 30 minutes, and works through the queue when it's back |
| The agent couldn't do the work | Marks it `blocked`, says what's needed, offers **Run again** |
| An update's original never got a report | Diagnoses it from scratch instead |
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

Press `b` in Sentinel's setup, or run:

```sh
spinuptui beacon setup basecamp
spinuptui sentinel setup --report-to board --apply
```

It finds the [Basecamp CLI](https://github.com/basecamp/basecamp-cli) and tells you how to install it if it's missing, shows who reports will post as, and lets you pick the project and who to @-mention from that project's people. It can post a test message first, which is a real post that the project's people may be notified of.

This is for your own team's record, so pick a project only your team is in: everyone in the project can read the reports. Agent output is never sent to a client. If a post fails, the page says so and the report is safe on disk; retry with `spinuptui sentinel post <incident>`. A post is never retried automatically, because Basecamp can't tell a retry from a second post.

### Who reports post as

Reports post as whichever Basecamp account the CLI is logged in to. If that's you, it works, but every report looks like you wrote it, and an @-mention may not notify its own author. Most teams use a separate Basecamp user. Posting as yourself is fine if you'd rather, and a separate user may take a seat on your plan.

To log the CLI in as a separate user, run this in a terminal on the Mac itself:

```sh
basecamp auth login --no-browser
```

1. Open the link it prints in a private window (Incognito). In a normal window, you're probably already signed in as yourself, and you'd connect your own account.
2. Sign in as the separate user. The page then says you're connected, and the terminal finishes the login.

**Not over SSH.** An SSH session can't use the Keychain, so `basecamp auth login --remote` saves its login in a plaintext file, `~/.config/basecamp/credentials.json`, and only SSH sessions read that file. The Mac's own sessions, including the one that posts the reports, don't, so reports would fail even though setup over SSH shows you as logged in. On a headless Mac, log in over Screen Sharing instead. If you've already logged in over SSH, run `basecamp auth logout` over SSH to clear the login from that file.

Setup shows the account before you choose a project, so you'll see if the wrong one connected. To change it, run `basecamp auth logout` and log in again.

### If the login can't be confirmed

Over SSH, or in an agent's shell, the login can't be confirmed even when it's fine, because those sessions can't read the Keychain. So you can still save the board by giving its project ID or any URL from the project, and the morning digest's Board line tells you whether it works.


## What the reports tell you to do

Every report ends with what to do about it, and Sentinel keeps those recommendations as a to-do list, so they don't get lost between reports. Each to-do gets an ID (`T-41`), a kind (`nginx`, `monitoring`, `plugin`, `server`, `sentinel`, `decision`, `watch`, or `note` for something the agent did itself), a scope (a site, a server, or the whole fleet), and a state: open, done, won't fix or snoozed.

- **The agent sees the list before it investigates:** the open, snoozed and recently closed items for the sites on that server, the server itself and the fleet, with your latest comment on each. It refers to an item already on record by its ID instead of writing it up again, and the report's bullets carry those IDs.
- **Your decisions stick.** Mark something won't fix, with a reason, and Sentinel stops recommending it. If the evidence later argues for it, it says so once, as a comment on that item.
- **A fix that didn't hold comes back.** If something marked done is back, the agent reopens it, and the page that announces the report says so. That's the only change the agent can make: closing, won't-fixing and snoozing are yours.
- The page for each report lists the items it created or confirmed, and the digest has a line with what's open, by kind, and what changed.

Work the list on the **Reports** tab (`7`). It has two lists, and `Tab` switches between them:

- **Reports:** every report in your workspace, newest first, with the site, the monitor that paged, how many of its to-dos are still open, and its summary. `⏎` reads the report in the right-hand pane, and `o` opens the file.
- **To-dos:** grouped by fleet, server and site, open ones first. `v` shows other states and `t` one kind. The right-hand pane has the item's detail, every report it appears in, and its history. `d` marks it done, `w` won't fix (the reason is required, because Sentinel reads it), `s` snoozes it to a date, `c` adds a comment and `r` reopens it. The legend shows only the keys that apply to the selected item, and `⏎` jumps to its newest report.

A site with open to-dos says so in its details on the Servers tab, and `⏎` on it opens the Reports tab filtered to that site. `x` shows every site again.

Or work it from the command line:

```
spinuptui todos list [--state open|done|wontfix|snoozed|all] [--kind <kind>] [--site <d>] [--server <host>]
spinuptui todos show T-41
spinuptui todos done T-41 "Added the monitor"
spinuptui todos wontfix T-12 "Only paying clients get monitors"
spinuptui todos snooze T-7 --until 2026-12-01
spinuptui todos comment T-41 "Waiting on the client"
spinuptui todos reopen T-41
```

A Claude session working on a to-do signs its changes `--as claude` (`claude@<machine>`), so its notes are kept apart from yours: Sentinel reads them as another agent's findings, and only you can mark something won't fix or snooze it.

**Where it's kept:** `~/SpinupTUI/sentinel/todos.jsonl`, wherever your workspace is, so it's backed up with your SpinupTUI folder. It's a log that's only ever appended to, one line per change, and a `.gitattributes` beside it lets git merge two machines' changes without a conflict. You can read it with `cat` or `jq`. Only the station creates to-dos; any machine can comment on them or change their state.

If the agent's list at the end of a report can't be read, the report is still saved, with the list left in it, and the page tells you. Fix the list in the report by hand and run `spinuptui todos import <report>`.

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
spinuptui todos list | show | done | wontfix | snooze | comment | reopen | import
```

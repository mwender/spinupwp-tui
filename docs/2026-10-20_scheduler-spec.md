# Scheduler — spec

Promoted from `docs/2026-10-15_ideas.md` (idea 1's Scheduler section and idea 4's "one clock") on 2026-10-20. Second module against the contract in `docs/2026-10-16_beacon-and-module-contract-spec.md`. Ships as `1.3.0-alpha.2` on npm's `next` tag (renumbered 2026-10-21: stable 1.2.0 shipped early without the modules, so their stable release is 1.3.0).

## What it is for

**Outcome framing: follow-ups that run themselves.** The fix you shipped today gets checked tomorrow at 8 without anyone remembering, and the result arrives on your pager. That's the story on the Modules screen and the landing page.

**Underneath, it is the station's clock.** Scheduler's dispatcher is the only OS-level scheduled unit SpinupTUI installs. Every other module's recurring work (Sentinel's ticks, the daily digest, Samurai's ban expiries, the station heartbeat) is a job inside it. Turning Scheduler on is what makes a machine a station.

## Scope

**In this round:**

- The dispatcher: `spinuptui scheduler tick`, run every 5 minutes by one LaunchAgent, installed and removed with `scheduler install|uninstall --plan|--apply`.
- Two job sources: jobs modules declare (`ScheduledJobDecl`), and user follow-ups as Markdown files, either in Scheduler's own state directory or in a git repository the user chooses.
- Four job kinds: `spinuptui` (run a SpinupTUI command and report), `script`, and `agent` with two adapters (Claude Code, Codex).
- Reports on disk, one Beacon message per run, sent in-process.
- The CLI for queuing and inspecting jobs, Scheduler on the Modules screen, and its `status()`.
- Headless commands stop loading the renderer (the open question in the Beacon spec).
- The cutover plan from the existing git-backed job runner, written so no job is lost or run twice.

**Not in this round:**

- The systemd user timer for Linux. `install --plan` already prints the units on Linux, but `--apply` refuses until a Linux station exists to test on.
- Any module job. Beacon has none, and the first real ones arrive with Sentinel. The module-job path is built and unit-tested now so Sentinel only has to declare its ticks.
- The station heartbeat (a Kuma push monitor pinged by a Scheduler job). It belongs to station setup.
- Long-running residents (Beacon's future inbound listener). A 5-minute tick is not a daemon; that question is Samurai's.

## The dispatcher

### One unit, on the calendar

`spinuptui scheduler install --apply` writes one LaunchAgent, `com.spinuptui.scheduler`, that runs `spinuptui scheduler tick` at every fifth minute of the hour and once at login.

**Calendar entries, not `StartInterval`.** The prior art is mixed, so this was checked before designing around it. A `StartInterval` LaunchAgent on an always-awake Mac was once found silently stalled for about 21 hours: loaded, last exit 0, and `launchctl print` showing `pended nondemand spawn = interval` with nothing ever spawning. A separate `StartCalendarInterval` watchdog was added to kick it. On the other hand, the git-backed job runner's own `StartInterval 300` agent ran 1,450 times in its first five days without a gap. So the wedge is real but rare. Twelve `StartCalendarInterval` entries (`Minute` 0, 5, … 55) cost nothing and use the scheduler that has never been seen to wedge, so Scheduler doesn't need a watchdog of its own. A missed tick (sleep, reboot) is coalesced by launchd into one run on wake, which the catch-up rules below already handle.

**A LaunchAgent, not a LaunchDaemon.** `agent` jobs need the GUI login keychain (headless Claude Code fails with an OAuth error when started without it, even over SSH). A consequence station setup must explain: after a reboot, nothing ticks until someone logs in.

**The unit carries everything a bare launchd environment lacks.**

- `ProgramArguments` names absolute paths: the Bun that ran `install` and the global `spinuptui` entry it found on the PATH. Nothing depends on the `#!/usr/bin/env bun` shebang resolving.
- `PATH` is written into the unit: the directories holding `bun`, `spinuptui`, `git`, `ssh`, `claude` and `codex` as found at install time, then the system directories. A working interactive shell proves nothing about a launchd run, which is why install ends with a real tick through launchd (below).
- `SPINUPTUI_SCHEDULER_DISPATCHER=1`, which is what lets `tick` run jobs at all. On any other machine, or from a shell, `tick` refuses unless given `--here`, so a stray `tick` on a laptop doesn't execute the station's jobs.
- `XDG_CONFIG_HOME`, copied if it was set at install. This is how a test install against a scratch config stays isolated from the real one.
- Output goes to `<stateDir>/launchd.log`, for crashes only.

**Never a path into a checkout.** Install refuses when the `spinuptui` it found resolves into a development checkout (a directory with `.git` above it, rather than a package install). `--bin <path>` overrides that explicitly, for testing.

### install and uninstall

```
spinuptui scheduler install   --plan | --apply [--bin <path>] [--json]
spinuptui scheduler uninstall --plan | --apply [--json]
```

The confirm-before-firing pattern from the pull commands: `--plan` prints exactly what would be written and run, `--apply` does it, and neither flag is an error. `install` is idempotent: re-running it rewrites the unit (picking up a new PATH or a moved Bun) and reloads it.

`--apply` finishes by **proving the unit works**: it kickstarts the job through `launchctl` and waits up to 60 seconds for a tick to record itself as coming from the dispatcher. Install isn't reported as done until that tick lands. The unit's label, path and install time are then saved under `scheduler.dispatcher` in `config.json` (a deliberate setup command, so it may write config).

`uninstall --apply` boots the unit out, deletes its file and clears `scheduler.dispatcher`. It keeps the state directory: user follow-ups and their reports are the user's data, not install artifacts.

`SPINUPTUI_SCHEDULER_LABEL` overrides the label, so a test install never collides with a real one.

On Linux, `--plan` prints a systemd user service and timer (`OnCalendar=*:0/5`, `Persistent=true`) and the `loginctl enable-linger` reminder; `--apply` refuses for now.

### What a tick does

1. **Takes the lock.** An exclusive, non-blocking `flock` on `<stateDir>/tick.lock`. A tick that finds a previous one still running (a long agent job) exits at once.
2. **Runs due module jobs** (below).
3. **For each user source**: takes that source's lock, pulls it if it's a git repository, runs each due job in turn, commits and pushes `runs/`.
4. **Records itself** in `<stateDir>/last-tick.json` (`{ at, via, ran, errors }`, replaced atomically) on every tick, and appends a line to `<stateDir>/tick.log` (JSON lines, rotated at 1 MB) when anything ran or failed. `status()` reads the first; the second is history.

Jobs run one at a time. Fleet work is mostly SSH and API calls against the same rate limit, so parallel jobs would mostly contend.

**Cost of a tick.** Every tick starts `spinuptui`. Until now `src/index.tsx` imported OpenTUI and the whole UI graph before looking at its arguments. Headless commands now dispatch before a dynamic import of the UI, so `tick` (and `beacon send`, `incidents`, `ssh-exec`) never load the renderer. That's also the first step for a Linux station, where the native library might not load at all.

## Jobs

### Module jobs

A module's `jobs: ScheduledJobDecl[]` are run by every tick when due. `every: "10m"` runs at that interval; `at: "08:00"` runs daily at that local time, once, catching up after a missed slot. `command` is a SpinupTUI subcommand and runs with the same Bun and entry point as the tick itself, so a module job always runs the same version as the dispatcher. A command beginning with `scheduler` is refused, since a job may not start a tick.

They differ from user follow-ups on purpose:

- **No expiry, no report files.** A module job lives as long as its module is configured. Its state is `<stateDir>/module-jobs/<id>.json`, and its output tail goes into `tick.log`.
- **Pages on change, not on every run.** A module job that fails pages once, and pages once more when it recovers. A heartbeat that paged every 5 minutes would train its reader to ignore the pager. Whether the work *itself* is worth a page (a site went down) is the module's business, through Beacon.
- **Only configured modules' jobs run.** A module whose `status()` is `not_configured` contributes nothing.

### User follow-ups: the job file

A follow-up is one Markdown file, `jobs/<id>.md`, in a source. The format is the git-backed runner's, unchanged, so existing jobs keep working:

```markdown
---
id: verify-410s                   # lowercase, digits, hyphens; must match the filename
kind: spinuptui                   # spinuptui | script | agent | codex
when: 2026-10-21 08:00            # one-shot, station local time ...
# every: weekdays 08:00           # ... or recurring: 30m, 6h, daily 08:00, weekdays 08:00, mon,thu 08:00
expires: 2026-10-28               # required; never runs after this day
created: 2026-10-20 15:30         # set by `add`; recurring jobs don't run slots before this
created_by: Claude Code — example.com session
workdir: ~/Projects/example       # default: the source's own directory
timeout: 30                       # minutes (default 30)
notify: beacon                    # beacon (default) | none. `telegram` is accepted as beacon.
to: pager                         # optional Beacon channel (default: Beacon's default)
agent: claude                     # agent jobs: claude (default) | codex
allow: Read,Grep,Glob             # claude: --allowedTools
add_dirs: ~/Projects/other        # claude: extra readable directories
model:                            # claude: optional model
sandbox: read-only                # codex: read-only (default) | workspace-write | danger-full-access
---
incidents example.com --hours 48
```

**Scheduling rules** (also unchanged): a one-shot job runs once, at or after `when:`. A recurring job runs the latest slot it missed, once, and never a slot earlier than `created:`. Nothing runs after `expires:`, and every job must have one, so a forgotten job stops on its own. Times are the station's local time.

**Write the body for a reader with no context.** A run starts cold. That's said in `add`'s help and in the agent preamble.

### Kinds

- **`spinuptui`** runs one SpinupTUI command: the body is its arguments, split like a shell would split them (quotes, no expansion). It is the native kind and the one to reach for first: `incidents example.com --hours 24`, `ssh-exec example.com -- 'curl -sI https://example.com/old-page'`. It runs with the dispatcher's own Bun and entry point. The digest is the output's last lines; for a JSON result with `ok: false`, it is the result's `message`.
- **`script`** runs the body with `/bin/bash -c` in `workdir`, for deterministic checks that don't need judgement.
- **`agent`** hands the body to an agent CLI, prefixed with standing rules: you're unattended; report, don't act; start the final message with `SUMMARY:` and one short paragraph, which becomes the digest. The CLI is an adapter, chosen by `agent:`, so this kind isn't tied to one vendor. Two ship:
  - `claude`: `claude -p <prompt> --permission-mode default --allowedTools <allow> --disallowedTools <always denied>`. The default `allow` is read-only (`Read,Grep,Glob`). `git push`, `git reset`, `git clean`, `rm -rf` and `sudo` are always denied, whatever `allow` says.
  - `codex`: `codex exec -s <sandbox> -C <workdir>`, read-only by default.
  
  `kind: codex` is kept as a synonym for `kind: agent` + `agent: codex`, for existing job files. Adding an adapter is a table entry: a binary name, how to build its argv, and how to recognize a lapsed login in its output.

**A lapsed agent login isn't a run.** No report is written. The job pages once per scheduled slot ("log in on the station") and retries every 30 minutes until it expires.

**An invalid job file is skipped** with one page per distinct problem, and the page isn't repeated until the problem changes.

### Sources

A **source** is a directory holding `jobs/` and `runs/`.

- **`local`** is built in: `<stateDir>` itself (`<configDir>/modules/scheduler/`). Queuing works with nothing set up.
- **Named sources** are directories the user adds with `scheduler source add <name> <path>`. When the directory is a git repository, the tick pulls it (`git pull --rebase --autostash`) before reading `jobs/` and commits and pushes `runs/` afterwards; a failed push is retried on the next tick. This is the prior art's best idea, kept whole: **queue from any machine** by committing a job file, and read results with `git pull`. Authors write `jobs/`; only the station writes `runs/`.

This is also the public-framework/private-data split. The engine is in SpinupTUI; the jobs, which name client sites and servers, live in a repository the user owns and SpinupTUI never sees on GitHub.

`add`, `cancel`, `list` and `show` take `--source <name>`. The default is `scheduler.defaultSource` if set (`source add --default`), else `local`. In a git source, `add` and `cancel` commit and push, as the prior art does.

**Each source has its own lock**, an `flock` on `<source>/.state/dispatch.lock`. That's the same file and the same lock call the existing runner uses, which is what makes the cutover below safe.

### Reports and state

The prior art's layout, so a source moves between dispatchers without conversion:

- **`runs/<id>/<YYYY-MM-DD-HHMM>.md`**: a header (scheduled, started, duration, exit code, kind, who queued it), then the output, capped at 200,000 characters.
- **`runs/<id>/state.json`**: `runs`, `last_run`, `last_scheduled`, `last_status`, `last_report`, plus `retry_after`, `auth_alerted_for` and `invalid` when they apply. The scheduling rules read only this file, so whoever holds the source's lock and reads it next makes the same decision.
- **One Beacon message per run** unless `notify: none`: status, duration, the digest, the report path and who queued it. It is sent in-process with `beaconSend`, not by spawning `spinuptui beacon send`. If Beacon isn't configured the run still completes, and the miss is recorded in `tick.log` and shown in `status()`. Scheduler doesn't carry a second sender.

## Commands

```
spinuptui scheduler status [--json]
spinuptui scheduler list [--source <name>] [--json]
spinuptui scheduler show <id> [--source <name>]
spinuptui scheduler add <id> --kind <kind> (--when "YYYY-MM-DD HH:MM" | --when now | --every <schedule>)
                        --expires YYYY-MM-DD --created-by <who> [--source <name>]
                        [--workdir …] [--timeout N] [--notify beacon|none] [--to <channel>]
                        [--agent claude|codex] [--allow …] [--add-dirs …] [--model …] [--sandbox …]
                        [--body-file <path> | -- <body>]          (else stdin)
                        [--replace] [--no-push]
spinuptui scheduler cancel <id> [--source <name>]
spinuptui scheduler run <id> [--source <name>]           run now, on this machine, through the real runner
spinuptui scheduler validate [--source <name>]
spinuptui scheduler source add <name> <path> [--default]
spinuptui scheduler source remove <name>
spinuptui scheduler tick [--here]
spinuptui scheduler install | uninstall --plan | --apply
```

As with every module: one JSON result on stdout with `--json`, progress on stderr, `{ ok: false, reason, message, remedy? }` on failure, exit 1 on failure. `add` validates the file before writing it, so a bad job never reaches a source. `--prompt-file` is accepted as an alias of `--body-file`, for muscle memory.

## Status

`status()` (and so `spinuptui modules`, `scheduler status` and the Modules screen) reports:

- **dispatcher**: installed or not (from `scheduler.dispatcher` and the unit file still existing).
- **last tick**: its age. Fine under 15 minutes (three missed ticks). Older than that with a dispatcher installed is `degraded`, the one-question answer to "is the station alive?".
- **sources**: each readable, and for git sources, whether the last pull and push worked.
- **jobs**: how many are active, and any whose last run failed.
- **Beacon**: whether digests can be delivered.

`not_configured` means no dispatcher is installed. The remedy is `spinuptui scheduler install --plan`.

## The Modules screen

Scheduler moves from `UPCOMING_MODULES` to `MODULES`. Its detail pane shows the status checks and the next few runs. `⏎` opens the install plan in a confirm overlay; confirming applies it, including the proving tick. Once installed, `⏎` reinstalls (the repair path). Queuing a follow-up stays a CLI action for now: it's done from agent sessions far more than by hand.

## Cutover from the existing runner

**The hazard is two dispatchers.** If the old runner's unit and Scheduler both tick the same jobs, a job could run twice, and a client-facing job running twice is the worst outcome here. Going quiet for a few minutes is not.

**What makes it safe.** Scheduler reads and writes the same `runs/<id>/state.json`, applies the same scheduling rules, and takes the same `flock` on the same `.state/dispatch.lock` in the source directory. So even with both units loaded on one machine, ticks are serialized by the lock, and each reads the state the other just wrote: a slot one of them has run is never due for the other. The overlap is harmless by construction, not by timing.

**Order of operations:**

1. Publish `1.3.0-alpha.2` and install it globally with `@next`. Check `spinuptui scheduler status` from a shell. Pull the old runner's repository, so the copy Scheduler shares state with is current.
2. `spinuptui scheduler source add <name> <the runner's repo> --default`. Then `scheduler list --source <name>` must show every existing job with the same next run the old runner's `list` shows. That's the proof the rules match.
3. `spinuptui scheduler install --apply`. Its proving tick runs against the shared state, so it runs nothing that isn't due.
4. Boot out the old runner's unit. Its plist file stays in place for rollback.
5. Watch one recurring slot and one one-shot run go through Scheduler: a report in `runs/`, a commit, a Beacon message (in Beacon's `send.log`), nothing in the old runner's log afterwards.
6. Afterwards, the old runner's repository keeps its jobs, reports and docs, and its CLI either stays as a thin `add`/`list` front end over the same files or is replaced by `spinuptui scheduler add --source`. Its dispatcher code is retired.

**Rollback** is `scheduler uninstall --apply` and bootstrapping the old unit again. The state is shared, so either one carries on from where the other stopped.

**The other LaunchAgents on the station** (the incident watcher and its watchdog, the daily digest, one-off follow-ups) move in later as Sentinel jobs and user follow-ups, each in the session that builds its module. Scheduler doesn't touch them.

## Testing

- **Unit tests** (`bun test`): schedule parsing, due-slot computation (including catch-up, `created` and `expires`), job-file parsing and validation, argument splitting, the launchd plist and systemd unit text, and the module-job change-only paging.
- **Live, isolated**: a scratch `XDG_CONFIG_HOME`, `SPINUPTUI_SCHEDULER_LABEL=com.spinuptui.scheduler-devtest`, and `--bin` pointing at a wrapper that runs this checkout. Install, watch the proving tick, queue a `script` and a `spinuptui` job with `--when now`, check their reports and state, hold a source's lock from another process and confirm the tick skips it, then uninstall and confirm the unit is gone. The real config and the real dispatcher units are never touched.

## Open questions

- **Missed-slot policy per job.** Catch-up runs the latest missed slot once. A "verify at 08:00" check run at 14:00 after a power cut is still useful; a "post the numbers before the client's 9am meeting" job may not be. A `late:` header (`run` or `skip`) is the obvious addition if a job ever needs it.
- **Which station runs a git source's jobs.** Today it's whichever machine installed a dispatcher and added the source. With two stations, both would run the same jobs, serialized only if they share a filesystem, which they wouldn't. A `station:` header, or a station claim recorded in the source, is a station-setup question.
- **Job output that contains secrets.** Reports are committed to the user's own repository. A `spinuptui` job's JSON can include paths and hostnames, never tokens, but a `script` job can print anything. That's the author's responsibility, as it is in the prior art; worth a line in `add`'s help.

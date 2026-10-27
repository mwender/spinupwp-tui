# Scheduler

Scheduler runs follow-ups for you. The fix you shipped today gets checked tomorrow at 8, without anyone having to remember, and the result arrives on your pager through [Beacon](beacon.md). You can queue a job from the CLI, from an agent session, or by committing a file to a git repository from any machine.

It's also the clock for SpinupTUI's other modules. Scheduler installs one scheduled unit, and everything recurring that a module needs to do runs as a job inside it. Turning Scheduler on is what makes a machine a **station**, so put it on a machine that stays awake.

The design, including how it replaces an existing job runner without running anything twice, is in [2026-10-20_scheduler-spec.md](2026-10-20_scheduler-spec.md).

## Turn it on

```sh
spinuptui scheduler install --plan     # shows exactly what it will write and run
spinuptui scheduler install --apply
```

Or open the **Modules** tab (`6`), select Scheduler and press `⏎`. It shows the same plan and installs it when you confirm.

On macOS this writes one LaunchAgent, `com.spinuptui.scheduler`, which runs `spinuptui scheduler tick` at login and at every fifth minute. The unit names the exact Bun and `spinuptui` it runs, and carries a PATH with the tools jobs need (`git`, `ssh`, and `claude` or `codex` if installed), because launchd starts jobs with almost no PATH at all. `--apply` isn't done until a tick has actually run under launchd, so a broken install shows up straight away, not tomorrow morning.

Things to know:

- **It needs a global install.** The dispatcher runs the `spinuptui` on your PATH, and refuses one that points into a development checkout. An unattended job should never run whatever happens to be checked out.
- **It runs while you're logged in.** A LaunchAgent doesn't start until someone logs in after a reboot. That's what lets agent jobs reach the login keychain.
- **Linux** support is coming. `--plan` already prints the systemd user timer it will use.
- **Set up Beacon first** (`spinuptui beacon setup`). Without it, jobs still run and write reports, but nobody is told about them.

`spinuptui scheduler uninstall --apply` removes the unit. Your jobs and reports stay where they are.

## Queue a follow-up

```sh
spinuptui scheduler add verify-410s \
  --kind spinuptui \
  --when "2026-10-21 08:00" --expires 2026-10-28 \
  --created-by "Claude Code — example.com session" \
  -- ssh-exec example.com -- 'curl -sI https://example.com/old-page'
```

`--when` takes a time in the station's local time, or `now` for the next tick. For recurring jobs, use `--every` instead: `30m`, `6h`, `daily 08:00`, `weekdays 08:00` or `mon,thu 08:00`. `--expires` is required, and nothing runs after that day, so a forgotten job stops on its own.

**Write the job for a reader with no context.** It runs cold, maybe days later. Name the domain, the paths, and what "fixed" looks like.

### Kinds

| Kind | The body is | Use it for |
| --- | --- | --- |
| `spinuptui` | A SpinupTUI command line, e.g. `incidents example.com --hours 24` | Checks SpinupTUI already knows how to do: incidents, read-only SSH checks, module status. Start here. |
| `script` | A bash script, run in `--workdir` | Deterministic checks that don't need judgement. |
| `agent` | A prompt for an agent CLI | Anything that needs reading and judgement. `--agent claude` (the default) or `--agent codex`. |

Agent jobs are **read-only by default.** Claude Code gets `Read,Grep,Glob` unless you pass `--allow` (for example `--allow "Read,Grep,Glob,Bash(ssh user@203.0.113.10 *)"`). `git push`, `git reset`, `git clean`, `rm -rf` and `sudo` are always denied. Codex runs in its `read-only` sandbox unless you pass `--sandbox`. Every agent prompt starts with standing rules: you're unattended, report rather than act, and begin the final message with `SUMMARY:` and one short paragraph. That paragraph becomes the message on your pager.

If the agent's login has lapsed, the job doesn't count as run. You get one page saying to log in on the station, and it retries every 30 minutes until it expires.

### Late slots

If the station was asleep or off when a job was due, it runs the job once when it comes back. That suits most follow-ups: a check meant for 08:00 is still worth running at 14:00. For a job that loses its point once late, say so with `--late`:

- `--late run` (the default): run it whenever the station gets to it.
- `--late skip`: run it only within 15 minutes of its time; otherwise skip it.
- `--late 2h` (or `45m`, …): the same, with your own grace window.

A skipped job is paged ("Skipped job post-numbers: it was due at 08:00, and this station only got to it at 14:10"), so a skip never looks like silence. `late:` only applies to jobs with a fixed time. A `30m`-style job simply runs on the next tick.

Other options: `--timeout <minutes>` (default 30), `--notify none` to skip the page, `--to <channel>` for a Beacon channel other than the default, `--workdir`, `--add-dirs` and `--model` for agent jobs, `--body-file <path>` instead of `-- …`, and `--replace` to overwrite a job with the same id.

## See what's queued and what happened

```sh
spinuptui scheduler list                 # every job: schedule, runs, last result, next run
spinuptui scheduler show verify-410s     # the job file and its latest report
spinuptui scheduler run verify-410s      # run it now, on this machine
spinuptui scheduler cancel verify-410s   # remove it; its reports stay
spinuptui scheduler status               # is the station's clock running?
```

Jobs and reports live in **`~/SpinupTUI/scheduler/`**, a visible folder that's yours to read, back up or share. It's created the first time you queue something, with a `README.md` that explains each part. (`SPINUPTUI_HOME` moves it. It's deliberately not in `~/Documents`, which iCloud may sync.) SpinupTUI's own bookkeeping (locks, the tick log) stays out of it, in `~/.config/spinupwp-tui/modules/scheduler/`.

Each run writes a report to `runs/<id>/<YYYY-MM-DD-HHMM>.md`, with the schedule, the duration, the exit code and the full output, and keeps `runs/<id>/state.json` up to date. A run that misses its slot (the machine was asleep or off) runs once on the next tick. Missed slots of a recurring job don't pile up.

`status` (and the Modules tab) reports how long ago the dispatcher last ticked. More than 15 minutes means the station's clock has stopped. A manual `run` doesn't count, so it can't hide a dead dispatcher.

## Know when the station itself stops

`status` can only tell you the clock stopped if you look. If the machine is off, the installed `spinuptui` is broken, or the LaunchAgent is gone, nothing on the station can page you, because the pager is on the station too. The heartbeat closes that gap from outside: at the end of every dispatcher tick, Scheduler pings an [Uptime Kuma](https://github.com/louislam/uptime-kuma) push monitor running on another machine. A small VPS is the easiest place for it. When the pings stop, Kuma alerts you through its own notifications.

If SpinupTUI already has your Kuma login (from site monitoring, `M` in the app), it sets the monitor up itself:

```sh
spinuptui scheduler heartbeat setup --plan     # what it will create, and who Kuma will alert
spinuptui scheduler heartbeat setup --apply
```

It creates a push monitor named `SpinupTUI station: <this machine>` that goes down after 15 minutes without a ping (three missed ticks), sends the first ping, and saves it. Run it again and it reuses that monitor. Kuma alerts through its default notification, or the only one you have. If you have several and none is the default, choose with `--notify <name>`.

Without a saved login, make the monitor by hand: in Kuma, **Add New Monitor** with **Monitor Type: Push**, **Heartbeat Interval: 900** seconds, and a notification. Copy its push URL, then:

```sh
spinuptui scheduler heartbeat set 'https://kuma.example.com/api/push/AbC123?status=up&msg=OK&ping='
```

`set` sends a ping first and saves the URL only if Kuma accepts it. Quote the URL, because it contains `?` and `&`.

Each ping carries the tick's result: what ran and the first problem, if there was one. It reports **down** when the station is running but can't page you, because Beacon isn't set up or its last page failed. A broken pager then reaches you through Kuma instead of going unnoticed. Manual ticks and `run` never ping, so they can't hide a dispatcher that has stopped. `spinuptui scheduler heartbeat` shows the last ping, `heartbeat test` sends one now, and `heartbeat remove` stops them; pause the monitor in Kuma too.

## Queue from anywhere: make it a git repository

To queue jobs from other machines, share `~/SpinupTUI/` through a private git repository. SpinupTUI does it for you, after showing you the plan:

```sh
spinuptui home sync --github spinuptui-home --plan          # create a private GitHub repository (needs gh)
spinuptui home sync --remote git@example.com:you/x.git --plan   # or use an empty private one you made
```

Run it again with `--apply` to do it: `git init`, a `.gitignore`, a first commit, the remote, a push. On the Modules tab, `f` on Scheduler does the same thing step by step. It refuses a folder inside iCloud, Dropbox or another sync service (two programs syncing one `.git` can corrupt it), a remote that already has commits, and a public GitHub repository. On a second machine, `spinuptui home sync --clone <url> --apply` sets up the same folder there. `spinuptui home` shows where the folder is and whether it's shared. You can also do it by hand with `git init` and a remote; Scheduler only cares that the folder is a repository.

That's all. Scheduler notices the repository and, before each tick, pulls it, runs whatever is due, then commits and pushes the reports. Its commits only ever touch `runs/` and its own claim file, never anything else you've changed or staged. On a laptop, clone the same repository to `~/SpinupTUI/`, and `scheduler add` there commits and pushes the job for you. Read results with `git pull`.

An existing folder or repository of jobs (in the same format) can be added as a named source instead:

```sh
spinuptui scheduler source add followups ~/Projects/followups --default
```

A job file is Markdown with a short header:

```markdown
---
id: verify-410s
kind: spinuptui
when: 2026-10-21 08:00
expires: 2026-10-28
created_by: Claude Code — example.com session
late: run
---
ssh-exec example.com -- 'curl -sI https://example.com/old-page'
```

`spinuptui scheduler validate` checks every job file. An invalid file is skipped, with one page about what's wrong.

Reports land in the repository, so keep secrets out of what jobs print.

### One station runs each repository

Every machine with a clone can queue jobs. Only one runs them: the **station** that claimed the repository. The first machine with a dispatcher installed claims it automatically by committing a small file (`.scheduler/station`, holding its hostname). If a second machine also gets a dispatcher, for example a laptop where someone pressed install on the Modules tab, it sees the claim and leaves those jobs alone. `scheduler status` says which machine runs what:

```
✓ source local: ~/SpinupTUI/scheduler (git, run by mini; this machine only queues)
```

To move the jobs to another machine, or to retire a station:

```sh
spinuptui scheduler source claim local     # on the new station: run them here from now on
spinuptui scheduler source release local   # on the old one: stop running them here
```

`claim` takes over at once, and the old station stops on its next pull. `release` removes the claim and stops this machine from claiming the source again. The next other station to tick takes it over. Use `local` for `~/SpinupTUI/`, or the name of a source you added.

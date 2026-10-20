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

Other options: `--timeout <minutes>` (default 30), `--notify none` to skip the page, `--to <channel>` for a Beacon channel other than the default, `--workdir`, `--add-dirs` and `--model` for agent jobs, `--body-file <path>` instead of `-- …`, and `--replace` to overwrite a job with the same id.

## See what's queued and what happened

```sh
spinuptui scheduler list                 # every job: schedule, runs, last result, next run
spinuptui scheduler show verify-410s     # the job file and its latest report
spinuptui scheduler run verify-410s      # run it now, on this machine
spinuptui scheduler cancel verify-410s   # remove it; its reports stay
spinuptui scheduler status               # is the station's clock running?
```

Each run writes a report to `runs/<id>/<YYYY-MM-DD-HHMM>.md`, with the schedule, the duration, the exit code and the full output, and keeps `runs/<id>/state.json` up to date. A run that misses its slot (the machine was asleep or off) runs once on the next tick. Missed slots of a recurring job don't pile up.

`status` (and the Modules tab) reports how long ago the dispatcher last ticked. More than 15 minutes means the station's clock has stopped. A manual `run` doesn't count, so it can't hide a dead dispatcher.

## Queue from anywhere: git sources

By default, jobs live in Scheduler's own folder (`~/.config/spinupwp-tui/modules/scheduler/`), the `local` source. To queue jobs from other machines, keep them in a git repository instead:

```sh
spinuptui scheduler source add followups ~/Projects/followups --default
```

Before each tick, the station pulls that repository, runs whatever is due, then commits and pushes `runs/`. To queue a job from a laptop, run `scheduler add` there against your own clone (it commits and pushes for you), or commit a job file by hand. Read results with `git pull`. Authors write `jobs/`, and only the station writes `runs/`, so the two never conflict.

A job file is Markdown with a short header:

```markdown
---
id: verify-410s
kind: spinuptui
when: 2026-10-21 08:00
expires: 2026-10-28
created_by: Claude Code — example.com session
---
ssh-exec example.com -- 'curl -sI https://example.com/old-page'
```

`spinuptui scheduler validate` checks every job file. An invalid file is skipped, with one page about what's wrong.

Reports land in that repository, so keep secrets out of what jobs print. The repository is yours: SpinupTUI's public code never sees the domains and servers your jobs name.

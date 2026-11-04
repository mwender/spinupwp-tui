<!-- Draft GitHub release notes for v1.3.0. Removed in the release commit; used as: gh release create v1.3.0 --verify-tag --title "<title below>" --notes-file release-notes-v1.3.0.md (after deleting this comment and the title line). -->
Title: v1.3.0 — Modules: Beacon, Scheduler and Sentinel

SpinupTUI now keeps working after you close it. Modules are the parts that run on their own on a machine that stays awake, a *station*: **Beacon** pages you, **Scheduler** runs follow-ups on a clock, and **Sentinel** watches the fleet, works out what actually broke, and writes it up. Each builds on the one before, and all three are set up from the new Modules tab (`6`), which shows what each will change before it changes anything.

## Highlights
- **Sentinel: know why, not just that it's down.** Every 5 minutes it checks Uptime Kuma, groups what went down by server and pages you. Then it writes it up: the evidence on its own, or a full diagnosis if you bring an agent CLI (Claude Code or Codex). The agent can only read servers, through `ssh-exec`, and can't post anything; Sentinel saves the report, posts it to your team's Basecamp board, and pages a one-line summary naming the site it blamed. A repeat within 6 hours becomes a follow-up on the same report.
- **A morning digest that only speaks up about what's new.** At 08:00: station health, the last 24 hours, server updates, and the things monitoring can't see, like a crawler that stopped arriving or a cache that stopped hitting. It's silent unless something needs you.
- **Beacon: one command that pages you.** `spinuptui beacon send` from any script, cron job or agent, on Telegram, with retries, long messages split instead of dropped, and a send log. A guided setup makes the bot with you. With the listener on, send `/jobs` to your bot to see the station's jobs, extend one about to expire, or run a failed one again.
- **Scheduler: follow-ups that run themselves.** Queue "check this tomorrow at 8" from any session, and the result arrives through Beacon. Jobs can be a SpinupTUI command, a script, or a read-only agent prompt, and every job expires so a forgotten one stops by itself. Jobs and reports live in `~/SpinupTUI/`, which `f` can share through a private git repository so you can queue from any machine.
- **Know when the station itself stops.** Each tick pings an Uptime Kuma push monitor you run elsewhere, so a station that's off, or can't page you, is noticed from outside (`h` on the Scheduler card).
- **Headless commands start about three times faster,** which matters for something started every five minutes.

## Notes
- **Stations are macOS-only for now.** Scheduler and Beacon's listener install LaunchAgents. The rest of SpinupTUI is unchanged.
- **Team boards post as whichever account the Basecamp CLI is logged in to;** a separate Basecamp user is recommended. On a headless Mac, log the CLI in over Screen Sharing, not SSH. See [docs/sentinel.md](https://github.com/mwender/spinupwp-tui/blob/v1.3.0/docs/sentinel.md#who-reports-post-as).
- **On a 1.3.0 alpha?** Nothing to migrate; move from `@next` to `@latest` or Homebrew.
- Details in [docs/sentinel.md](https://github.com/mwender/spinupwp-tui/blob/v1.3.0/docs/sentinel.md), [docs/scheduler.md](https://github.com/mwender/spinupwp-tui/blob/v1.3.0/docs/scheduler.md) and [docs/beacon.md](https://github.com/mwender/spinupwp-tui/blob/v1.3.0/docs/beacon.md). New site: [spinuptui.com](https://spinuptui.com).

**Update:** `brew upgrade spinuptui` (Homebrew) or `bun add -g spinuptui@latest --no-cache` (npm install). New to SpinupTUI? `brew install mwender/tap/spinuptui`.

**Full changelog:** https://github.com/mwender/spinupwp-tui/compare/v1.2.2...v1.3.0

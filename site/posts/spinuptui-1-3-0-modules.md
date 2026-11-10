---
title: SpinupTUI 1.3.0: modules that keep watch after you close it
date: 2026-11-10
summary: SpinupTUI 1.3.0 adds modules, parts of the app that run on their own on an always-on Mac. Sentinel works out what broke, Beacon pages you, and Scheduler follows up.
release: v1.3.0
---

Until now, SpinupTUI only worked while it was open. That's fine for checking on a fleet, but outages don't wait for you to open a terminal.

**SpinupTUI 1.3.0 adds modules: parts of the app that keep working after you quit.** Put SpinupTUI on a Mac that stays awake, turn the modules on, and walk away. We call that Mac a *station*.

Three modules ship today.

## ◈ Sentinel works out what broke

Uptime monitoring tells you a site is down. It doesn't tell you why, and the why is where the time goes.

Sentinel checks Uptime Kuma every five minutes. When something goes down, it:

1. **Groups it by server**, so five monitors paging for one overloaded box is one incident, not five.
2. **Pages you right away** with what it knows.
3. **Gathers the evidence**: the server's load and memory, the other sites on the box, and whether the page is really failing.
4. **Diagnoses it**, if you bring an agent CLI like Claude Code or Codex. The agent can only *read* your servers, and it can't post anything.
5. **Files the report** on your team's Basecamp board, then pages you a one-line summary that names the site to blame.

The site that pages often isn't the site that caused it. Sentinel looks at the whole box before it decides.

**Every morning at 8:00, you get a digest**, and it only speaks up about what's new. It covers the last 24 hours, pending server updates, and things uptime monitoring can't see, like a crawler that stopped arriving or a cache that stopped hitting.

## ◉ Beacon pages you

Beacon is one command, `spinuptui beacon send`, that pages you on Telegram. Sentinel uses it, and so can any script, cron job or agent of your own.

Your pager can also answer back. Send `/jobs` to see what the station is running, extend a job that's about to expire, or run a failed one again.

## ◷ Scheduler follows up

You fixed something today. Will you remember to check it tomorrow?

Scheduler remembers for you. Queue "check this tomorrow at 8" from any session, and the station runs it and sends you the result. A job can be a SpinupTUI command, a script, or a read-only agent prompt. Every job has an expiry date, so a forgotten one stops by itself.

## Its first week on a real fleet

Before calling it stable, we ran Sentinel on our own production fleet for a week.

- **2,010 of 2,010 checks ran**, one every five minutes, with no failures.
- **18 incidents**, every one diagnosed, written up and posted to the board.
- **Real finds:** a database server killed for memory during an unattended upgrade, a plugin fatal on PHP 8 that a bot kept setting off, and scanners knocking over sites with request bursts.
- **One bug,** in how Sentinel read an "already documented" answer. It's fixed in this release.

## Also in 1.3.0

- **Choose how often Uptime Kuma checks a site:** every 1, 2, 5 or 10 minutes. Thanks to [@lumpysimon](https://github.com/lumpysimon) for the request.
- **Headless commands start about three times faster.**
- **A reboot's Kuma maintenance window now ends by itself** after 30 minutes, so monitors never stay silenced.

## Get it

```
brew install mwender/tap/spinuptui
```

Already on SpinupTUI? Run `brew upgrade spinuptui`, or `bun add -g spinuptui@latest --no-cache`. Then open the **Modules** tab (`6`). Each module shows what it will change before it changes anything.

Stations are macOS-only for now. Everything else in SpinupTUI works as before.

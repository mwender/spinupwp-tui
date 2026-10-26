# Beacon and the module contract — spec

Promoted from `docs/2026-10-15_ideas.md` (ideas 1, 4 and 5) on 2026-10-16. This is the first step of the integration plan: define how a module plugs into SpinupTUI, then build Beacon as the first module to implement it. Scheduler, Sentinel and Samurai follow in later sessions, in that order, each against this contract.

## Scope

**In this round:**

- The module contract: what every module declares, where its config and state live, and how its status is reported.
- Beacon's operator channel, Telegram only: config, secrets, `spinuptui beacon send` and the commands around it.
- Onboarding for someone who has never made a Telegram bot: a guided setup, in the CLI and the TUI.
- The Modules screen (tab `6`): Beacon live, the other three shown as "coming soon".
- The cutover plan for the existing Telegram senders, written so live alerting never goes quiet.

**Not in this round** (designed enough below that nothing built now blocks them):

- The client channel (Basecamp). Its shape is sketched under "Later", but it is not built until a module needs to post to a client, which is Sentinel.
- Two-way Beacon (inline approval buttons and the inbound listener). That arrives with Samurai.
- More operator transports (Slack, ntfy, Pushover, email, webhook). The channel type is a union so each is an additive change.
- `station setup`. It is a view over the contract and comes after the four modules exist.

## The module contract

A module is a feature that keeps working after the TUI is closed. Every module ships inside the `spinuptui` package and describes itself with one declaration, so the Modules screen, `station setup` and `spinuptui modules` can all be built over the same data instead of knowing each module by hand.

```ts
interface ModuleDefinition {
  id: ModuleId                  // "beacon" | "scheduler" | "sentinel" | "samurai"
  name: string                  // "Beacon"
  summary: string               // outcome copy, shared with the landing page
  dependsOn: ModuleId[]         // installed first; status shows what's missing
  configKey: string             // top-level key in config.json (= id)
  stateDir(): string            // <configDir>/modules/<id>/: machine state
  workDir(): string             // ~/SpinupTUI/<id>/: the user's work (added 2026-10-23)
  jobs: ScheduledJobDecl[]      // recurring work, handed to Scheduler (Beacon: none)
  status(): Promise<ModuleStatus>
}

interface ModuleStatus {
  id: ModuleId
  state: "not_configured" | "ok" | "degraded"
  summary: string               // one line for a list view
  checks: { name: string; ok: boolean; detail: string }[]
  remedy?: string               // what to run when not ok
}

interface ScheduledJobDecl {
  id: string                    // "sentinel.tick"
  every?: string                // "5m", "10m"
  at?: string                   // "08:00"
  command: string[]             // a spinuptui subcommand, never a path into a checkout
}
```

**The rules behind the shape:**

- **Config lives in one place.** A module's settings are a top-level key in the existing `config.json`, named after the module. The key is machine-level, not per account: one operator's pager serves every SpinupWP account on the machine, the same way the Uptime Kuma login does. A module that later needs per-account data (Sentinel's per-site expectations) adds it to the profile keys explicitly.
- **State lives in its own directory.** Logs, locks and high-water marks go in `<configDir>/modules/<id>/`. Nothing a module writes during a run touches `config.json`. Writes to `config.json` are not atomic and not locked, and a frequent unattended writer racing a running TUI would lose one side's change. Config is written only by deliberate setup commands.
- **Your work lives where you can see it.** Anything a person reads, keeps or shares (Scheduler's jobs and reports, Sentinel's write-ups, Samurai's proposals) goes in `~/SpinupTUI/<id>/`, not in the hidden config directory next to tokens. It's created on first use, `SPINUPTUI_HOME` (or `homeDir` in `config.json`) moves it, and it's deliberately not `~/Documents`, which iCloud may sync. Added 2026-10-23 with Scheduler; see `docs/2026-10-20_scheduler-spec.md`.
- **Schedules are declarations, not OS units.** A module never installs a launchd or systemd unit. It lists its recurring jobs, and Scheduler (next session) runs them from its single dispatcher. Beacon has no recurring work, so its list is empty.
- **Status is a function, not a file.** `status()` computes health on demand from config and state, so it can't go stale. It must be cheap and must not send anything.
- **Every module has a CLI first.** The TUI is a front end over the same functions. Headless commands print one JSON result on stdout and progress on stderr, and use the existing `{ ok: false, reason, message, remedy? }` failure shape.

`spinuptui modules [--json]` lists every module with its status, plus the ones not shipped yet (`upcoming`). The Modules screen is the same data in the TUI.

### The Modules screen

Tab `6`. A list on the left with one row per module (● set up, ○ not set up, ● amber needs attention, · coming soon) and a detail pane on the right: the outcome summary, what it builds on, its status checks, and what to do next. `⏎` sets up the selected module, so the place you learn what a module does is the place you turn it on. Beacon adds `t` for a test page.

Unshipped modules appear greyed out as "coming soon". They come from a separate `UPCOMING_MODULES` list holding only an id, name, summary and dependencies, and an entry moves into `MODULES` when it ships. The ideas doc warned that listing unbuilt products reads as vaporware, but that was about the public landing page. Inside the app, next to one live module, they read as a roadmap.

## Beacon

One notification layer for everything SpinupTUI and its modules need to say. This round builds the **operator channel**: a pager for the person who runs the fleet. It's short, actionable and allowed to be noisy.

### Config and secrets

Beacon's config is the `beacon` key in `config.json`:

```json
{
  "beacon": {
    "defaultChannel": "pager",
    "channels": {
      "pager": { "type": "telegram", "botToken": "…", "chatId": "…" }
    }
  }
}
```

- **Channels are named.** A sender addresses a name (`--to pager`), never a transport. That leaves room for a second chat or a different transport without touching any caller. With one channel, it is the default automatically.
- **Secrets live in `config.json` (mode 600), not the Keychain.** This follows the precedent of the Kuma login and the DNS provider credentials, and it is the only option that works for a station. A LaunchAgent can find the login Keychain locked after a reboot, Linux has no Keychain at all, and libsecret needs a session bus a headless box may not have. The Keychain stays reserved for sudo passwords, which are interactive by nature.
- **Environment override, read-only.** `SPINUPTUI_BEACON_TELEGRAM_TOKEN` plus `SPINUPTUI_BEACON_TELEGRAM_CHAT_ID` define a channel named `env`, which becomes the default when no stored channel is set as default. It is marked as coming from the environment and can't be edited or removed through Beacon. The `SPINUP` prefix means the `.env` scrub keeps it.
- **Secrets never go on a command line.** `beacon add` reads them from an env file or the environment, never from argv, where `ps` would show them. Output always masks them.

### Commands

```
spinuptui beacon setup [<name>]
spinuptui beacon send [--to <channel>] [--silent] [--json] [<message> | -]
spinuptui beacon add telegram <name> [--env-file <path>] [--default] [--no-test]
spinuptui beacon remove <name>
spinuptui beacon test [--to <channel>]
spinuptui beacon status [--json]
spinuptui modules [--json]
```

**`send`.** The message is the positional argument, or stdin when it is `-` or absent and stdin isn't a terminal. That's how multi-line digests and report files go through. Text is sent as plain text, never parsed as Markdown or HTML, so an underscore in a domain can't break a page, and link previews are off. `--silent` delivers without a notification sound, for heartbeats and digests.

- **Long messages are split, not dropped.** Telegram rejects anything over 4096 characters. Beacon splits on line boundaries into numbered parts (`(1/3)`), up to 5 parts, and truncates the last one with a marker beyond that. Before this, a long digest or report was lost silently.
- **Retries.** Three attempts with a 15-second timeout each, honoring Telegram's `retry_after` on a 429 and backing off on 5xx or network errors. A 4xx other than 429 isn't retried, because a bad token or chat id won't fix itself.
- **Every send is logged** to `modules/beacon/send.log` (JSON lines: time, channel, ok, parts, character count, error, and the first 80 characters as a preview). This is the record that proves the cutover is working. The log is capped by rotating it at 1 MB.
- **Exit codes callers can branch on:** `0` delivered; `1` usage error or Beacon not configured (nothing was attempted); `2` delivery failed after retries (Beacon was configured and tried). The distinction is load-bearing for the cutover below.
- `--json` prints `{ ok, channel, parts, … }` on stdout. Without it, success is silent and failure is one line on stderr, which is what a shell caller wants.

**`setup`.** The guided path for someone without a bot (next section). Interactive only; it refuses to run without a terminal and points at `add`.

**`add telegram`.** Reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from `--env-file` (the format existing senders already use) or the same names from the environment. Before saving, it checks the token with Telegram's `getMe` and sends a "Beacon connected" test message. Credentials that can't deliver are never stored. `--no-test` skips the test message but not the token check.

**`test`.** Sends a test message that names the machine and the time, so you can tell which station sent it.

**`status`.** The module contract's status, printed. It reports the channels (masked), which channel is the default, and the outcome of the last send from the log. It doesn't send anything.

### Onboarding: a first bot in about two minutes

`beacon add` assumes you already have a bot token and a chat ID. A newcomer has neither, and the chat ID is where people get stuck: it's a number Telegram never shows in its apps. The guided setup (`spinuptui beacon setup`, or `⏎` on Beacon in the Modules screen) takes care of it. Both run the same engine (`src/lib/beaconSetup.ts`):

1. **Create a bot.** This can't be automated: Telegram issues bots only through a chat with @BotFather. Setup shows the three steps (`/newbot`, a name, a username ending in "bot") and asks for the token.
2. **Check the token.** A shape check catches a mis-paste instantly, then `getMe` confirms it and gives the bot's @username for the next step's link.
3. **Find the chat.** Setup asks the user to message the bot (or add it to a group and send `/start`), then long-polls `getUpdates` until a message, channel post or group membership arrives, for up to five minutes. Updates already waiting when setup starts are skipped, so an old conversation can't be picked by mistake. A `409` (the bot has a webhook, or something else is polling it) gets a plain explanation, since Telegram's text for it is cryptic.
4. **Confirm, test, save.** The user confirms the chat, Beacon sends "Beacon connected", and only then is the channel saved.

The token is entered hidden: masked in the TUI by the existing `SecretInput`, and in raw mode with dots in the CLI. It never touches argv. Re-running setup reconfigures the default channel rather than adding a second one, which also makes it the way to move the pager to a different chat.

Reading updates acknowledges them on Telegram's side. That's harmless for a bot used only for paging. A bot that also serves something else is the conflict case above, and the advice is a dedicated alert bot.

### Later: the client channel and two-way Beacon

Sketched here so the operator channel doesn't paint them into a corner:

- **Client channel.** A channel type `basecamp` with a project and a thread, sending through the `basecamp` CLI (the existing Markdown→Basecamp converter moves into Beacon with it). It differs from the pager by rule, not just transport. It only sends **templated or reviewed text**, it is confirm-gated unless the template is pre-approved, and a send is idempotent per (template, subject, thread), so a re-run can't double-post to a client. It's built with Sentinel, its first user.
- **Two-way.** Telegram inline buttons for approvals, received by long-polling (no open port), so a station can ask "Ban 203.0.113.0/24 on site X for 24h? [Approve] [Ignore]". Long-polling needs a resident process, which is a Scheduler question as much as a Beacon one. It's built with Samurai.

## Cutover: switching the existing senders without a gap

Today several scripts outside this repo each carry their own Telegram call against the same bot and chat: a shared notification library used by an incident watcher, a daily digest and two follow-up checks; two host watchers (power and OS updates); and a job runner. They all read the same `KEY=VALUE` env file. One more sender runs on a separate Linux box where SpinupTUI isn't installed. It stays as it is until a Linux station exists.

### The hazard that shapes the plan

**Unattended automation runs the published global `spinuptui`, not a development checkout.** So nothing can switch until Beacon is in a release and that release is installed. Worse, a `spinuptui` older than Beacon treats an unknown subcommand as "launch the TUI": `spinuptui beacon send …` under launchd would try to start the renderer instead of failing. **No caller may invoke `beacon` without first checking that the installed version has it.**

### The caller pattern

Every switched sender uses the same three-way branch:

1. **Check that Beacon is there.** Run `spinuptui --help` and look for `beacon send`. If it isn't listed, or `spinuptui` isn't on the PATH, use the old direct send. Cache the answer for the run, not across runs, so an upgrade is picked up on the next tick. (Until 2026-10-21 this step compared the version against `1.2.0`. That broke when stable 1.2.0 shipped without Beacon; see "Release plan".)
2. **Send through Beacon.** Exit `0` means done.
3. **Fall back only when Beacon didn't try.** Exit `1` (not configured, usage error) means nothing was sent, so the old direct send runs. Exit `2` means Beacon tried and Telegram refused or was unreachable. Retrying the same API from the old path would only duplicate a partial multi-part send, so the caller logs it and moves on, as it does today.

The old direct-send code stays in each caller as the fallback until the soak below is over. The env file stays too, since the fallback reads it.

### Order of operations

1. **Publish Beacon as a pre-release** (`1.2.0-alpha.N` on npm's `next` tag; see "Release plan") and install it globally on the station with `@next`.
2. **Configure it from the existing env file**: `spinuptui beacon add telegram pager --env-file <the existing file> --default`. The test message arriving is the first proof.
3. **Switch the shared notification library first.** One function covers four callers, including the daily digest, so the next morning's digest is a natural end-to-end check. It also immediately fixes the library's two latent bugs: HTTP errors counted as success, and long digests dropped silently.
4. **Then the job runner**, whose own delivery log makes the switch easy to verify.
5. **Then the two host watchers.** Do these last, because the power watcher matters most during an outage, which is exactly when a regression would hide. Keep their behavior of only marking a notice as sent after a successful send (exit `0`).
6. **Soak for a week.** Compare Beacon's `send.log` against each caller's own log. Every expected message should appear once, with no exit-`1` fallbacks after step 2.
7. **Remove the fallbacks** caller by caller, and only then retire the env file. Beacon's credentials then live only in `config.json`. Before that step, the machine's secrets-sync tooling has to cover `config.json`'s Beacon key, or a rebuilt station loses its pager.

Rollback at any point is reverting one caller's change. The env file and the old code path are still there until step 7.

## Release plan

Decided 2026-10-16: Beacon on its own is a useful tool, but the public story lands with Sentinel. So the modules ship through a **pre-release channel** first:

- **`1.2.0-alpha.N` on npm's `next` dist-tag**, published as GitHub pre-releases. `bun add -g spinuptui@next` opts in; `@latest`, the in-app update hint and the Homebrew tap all stay on stable. Scheduler and Sentinel arrive as further alphas.
- **Stable 1.2.0 ships once Sentinel is in**, alongside the landing page.
- **The update check understands pre-releases.** Someone on `1.2.0-alpha.3` is told when stable `1.2.0` ships, because a release outranks its own pre-releases. GitHub's "latest release" endpoint skips pre-releases, so alpha users aren't told about newer alphas. That's acceptable for a channel people opted into by hand.
- **The cost:** until stable 1.2.0, `main` carries unreleased module work. A fix for 1.1.x users is cut from a short-lived branch off the last stable tag, and merged forward.

**Renumbered 2026-10-21.** A critical PHP advisory needed a stable release before the modules were ready, so stable **1.2.0** shipped a different feature (taking sites offline) from a branch off `v1.1.2`, without Beacon or the Modules tab. The modules continue as **`1.3.0-alpha.N`**, and their stable release is **1.3.0**. `1.2.0-alpha.1` stays published but is superseded. Scripts that gated Beacon on `>= 1.2.0` now check `spinuptui --help` instead (step 1 of "The caller pattern").

## Open questions

- **Headless commands still load OpenTUI.** `src/index.tsx` imports the renderer and UI modules statically, so `beacon send` evaluates them even though it never draws. That's harmless on macOS. On a Linux station where the native library might not load, it would break every headless command. Moving the headless dispatch ahead of a dynamic import of the UI is the fix. It belongs with the Linux station spike, but anything that touches the dispatcher should avoid making it worse.
- **Rate of pages.** Beacon doesn't deduplicate or rate-limit; callers already decide when to page. If Sentinel turns out to be chatty, deduplication belongs in Sentinel's triage, not in the transport.
- **Machine identity in messages.** `test` names the host. Should every send carry a station prefix once there can be more than one station? Probably as an opt-in per channel, decided with station setup.

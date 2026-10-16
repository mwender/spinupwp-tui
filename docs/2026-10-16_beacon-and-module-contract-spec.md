# Beacon and the module contract — spec

Promoted from `docs/2026-10-15_ideas.md` (ideas 1, 4 and 5) on 2026-10-16. This is the first step of the integration plan: define how a module plugs into SpinupTUI, then build Beacon as the first module to implement it. Scheduler, Sentinel and Samurai follow in later sessions, in that order, each against this contract.

## Scope

**In this round:**

- The module contract: what every module declares, where its config and state live, and how its status is reported.
- Beacon's operator channel, Telegram only: config, secrets, `spinuptui beacon send` and the commands around it.
- The cutover plan for the existing Telegram senders, written so live alerting never goes quiet.

**Not in this round** (designed enough below that nothing built now blocks them):

- The client channel (Basecamp). Its shape is sketched under "Later", but it is not built until a module needs to post to a client, which is Sentinel.
- Two-way Beacon (inline approval buttons and the inbound listener). That arrives with Samurai.
- More operator transports (Slack, ntfy, Pushover, email, webhook). The channel type is a union so each is an additive change.
- The Modules screen in the TUI and `station setup`. They are views over the contract and come after the four modules exist.

## The module contract

A module is a feature that keeps working after the TUI is closed. Every module ships inside the `spinuptui` package and describes itself with one declaration, so the Modules screen, `station setup` and `spinuptui modules` can all be built over the same data instead of knowing each module by hand.

```ts
interface ModuleDefinition {
  id: ModuleId                  // "beacon" | "scheduler" | "sentinel" | "samurai"
  name: string                  // "Beacon"
  summary: string               // outcome copy, shared with the landing page
  dependsOn: ModuleId[]         // installed first; status shows what's missing
  configKey: string             // top-level key in config.json (= id)
  stateDir(): string            // <configDir>/modules/<id>/
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
- **State lives in its own directory.** Logs, high-water marks and reports go in `<configDir>/modules/<id>/`. Nothing a module writes during a run touches `config.json`. Writes to `config.json` are not atomic and not locked, and a frequent unattended writer racing a running TUI would lose one side's change. Config is written only by deliberate setup commands.
- **Schedules are declarations, not OS units.** A module never installs a launchd or systemd unit. It lists its recurring jobs, and Scheduler (next session) runs them from its single dispatcher. Beacon has no recurring work, so its list is empty.
- **Status is a function, not a file.** `status()` computes health on demand from config and state, so it can't go stale. It must be cheap and must not send anything.
- **Every module has a CLI first.** The TUI is a front end over the same functions. Headless commands print one JSON result on stdout and progress on stderr, and use the existing `{ ok: false, reason, message, remedy? }` failure shape.

`spinuptui modules [--json]` lists every module with its status. It is the first consumer of the contract and the seed of the Modules screen.

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

**`add telegram`.** Reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from `--env-file` (the format existing senders already use) or the same names from the environment. Before saving, it checks the token with Telegram's `getMe` and sends a "Beacon connected" test message. Credentials that can't deliver are never stored. `--no-test` skips the test message but not the token check.

**`test`.** Sends a test message that names the machine and the time, so you can tell which station sent it.

**`status`.** The module contract's status, printed. It reports the channels (masked), which channel is the default, and the outcome of the last send from the log. It doesn't send anything.

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

1. **Gate on the version.** Run `spinuptui --version` and check it's at least the Beacon release. If it isn't, or `spinuptui` isn't on the PATH, use the old direct send. Cache the answer for the run, not across runs, so an upgrade is picked up on the next tick.
2. **Send through Beacon.** Exit `0` means done.
3. **Fall back only when Beacon didn't try.** Exit `1` (not configured, usage error) means nothing was sent, so the old direct send runs. Exit `2` means Beacon tried and Telegram refused or was unreachable. Retrying the same API from the old path would only duplicate a partial multi-part send, so the caller logs it and moves on, as it does today.

The old direct-send code stays in each caller as the fallback until the soak below is over. The env file stays too, since the fallback reads it.

### Order of operations

1. **Release Beacon** (a minor version: new subcommands, no breaking change) and install it globally on the station.
2. **Configure it from the existing env file**: `spinuptui beacon add telegram pager --env-file <the existing file> --default`. The test message arriving is the first proof.
3. **Switch the shared notification library first.** One function covers four callers, including the daily digest, so the next morning's digest is a natural end-to-end check. It also immediately fixes the library's two latent bugs: HTTP errors counted as success, and long digests dropped silently.
4. **Then the job runner**, whose own delivery log makes the switch easy to verify.
5. **Then the two host watchers.** Do these last, because the power watcher matters most during an outage, which is exactly when a regression would hide. Keep their behavior of only marking a notice as sent after a successful send (exit `0`).
6. **Soak for a week.** Compare Beacon's `send.log` against each caller's own log. Every expected message should appear once, with no exit-`1` fallbacks after step 2.
7. **Remove the fallbacks** caller by caller, and only then retire the env file. Beacon's credentials then live only in `config.json`. Before that step, the machine's secrets-sync tooling has to cover `config.json`'s Beacon key, or a rebuilt station loses its pager.

Rollback at any point is reverting one caller's change. The env file and the old code path are still there until step 7.

## Open questions

- **Headless commands still load OpenTUI.** `src/index.tsx` imports the renderer and UI modules statically, so `beacon send` evaluates them even though it never draws. That's harmless on macOS. On a Linux station where the native library might not load, it would break every headless command. Moving the headless dispatch ahead of a dynamic import of the UI is the fix. It belongs with the Linux station spike, but anything that touches the dispatcher should avoid making it worse.
- **Rate of pages.** Beacon doesn't deduplicate or rate-limit; callers already decide when to page. If Sentinel turns out to be chatty, deduplication belongs in Sentinel's triage, not in the transport.
- **Machine identity in messages.** `test` names the host. Should every send carry a station prefix once there can be more than one station? Probably as an opt-in per channel, decided with station setup.

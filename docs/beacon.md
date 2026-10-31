# Beacon

Beacon is SpinupTUI's notification layer: one command that pages you, which any script, cron job, watcher or agent can call instead of carrying its own copy of "send a Telegram message". It is the first of SpinupTUI's modules, the features that keep working after the TUI is closed (`spinuptui modules` lists them).

Today Beacon has one kind of channel, Telegram, for the person who runs the fleet. More transports and a client-facing channel are planned; the design is in [2026-10-16_beacon-and-module-contract-spec.md](2026-10-16_beacon-and-module-contract-spec.md).

## Set up a channel

The easiest way is the guided setup. Open the **Modules** tab (`6`), select Beacon and press `⏎`, or run it in a terminal:

```sh
spinuptui beacon setup
```

Either one walks you through three steps:

1. **Create a bot.** Telegram issues bots only through a chat with [@BotFather](https://t.me/BotFather): send it `/newbot`, pick a name and a username ending in "bot", and copy the token it replies with. This is the one step SpinupTUI can't do for you. If you already have a bot, reuse it.
2. **Paste the token.** It's hidden as you type, and checked with Telegram straight away.
3. **Message your bot.** Send it anything from the chat you want paged, and Beacon picks up the chat by itself. No hunting for a chat ID. To page a group instead, add the bot to the group and send `/start` there.

Beacon then sends a "Beacon connected" message to that chat, and saves the channel only once it has arrived. Credentials that can't deliver are never stored. Messages that were already waiting for the bot when setup started are ignored, so an old conversation can't be picked by mistake. Running setup again reconfigures the same channel, so it's also how you move the pager to a different chat.

The credentials are saved in SpinupTUI's `config.json`, which only you can read (like the rest of its credentials). They're never accepted as command-line arguments, where other users of the machine could see them in the process list.

### Without a terminal: `beacon add`

For scripts and provisioning, put the token and chat ID in a `KEY=VALUE` file:

```sh
TELEGRAM_BOT_TOKEN=123456789:AA…
TELEGRAM_CHAT_ID=-100…
```

Then:

```sh
spinuptui beacon add telegram pager --env-file ~/path/to/telegram.env
```

It checks the token and sends the test message before saving, just like setup. The first channel you add becomes the default. Add `--default` to make a later one the default, or `--no-test` to skip the test message (the token is still checked).

Alternatively, set `SPINUPTUI_BEACON_TELEGRAM_TOKEN` and `SPINUPTUI_BEACON_TELEGRAM_CHAT_ID` in the environment. That defines a read-only channel named `env`, which is the default unless you've chosen another.

## Send

```sh
spinuptui beacon send "web1 is down"
some-report | spinuptui beacon send --silent
spinuptui beacon send --to pager -- "-5% disk free on web2"
```

- The message is the argument, or stdin when the argument is `-` or missing. Use `--` before a message that starts with a dash.
- Text is sent as plain text (no Markdown parsing, so underscores and asterisks in domains are safe), with link previews off.
- `--silent` delivers without a notification sound. That's useful for digests and heartbeats.
- Anything longer than Telegram's 4096-character limit is split on line boundaries into numbered parts, up to five. Beyond that the last part says how much was left out.
- Failed sends are retried three times, waiting as long as Telegram asks when it rate-limits. A bad token or chat id isn't retried.
- `--json` prints the result as one JSON object.

### Exit codes

Scripts can branch on these:

| Code | Meaning | What a caller should do |
|---|---|---|
| `0` | Delivered | Nothing |
| `1` | Usage error, or Beacon isn't configured. Nothing was attempted. | Fall back to another way of alerting, if you have one |
| `2` | Beacon tried, and Telegram refused or was unreachable after retries | Log it. Don't resend through another path; part of a long message may already have arrived. |

### Calling Beacon from existing scripts

`spinuptui` versions without Beacon don't know the `beacon` subcommand and will try to open the dashboard instead of failing. A script that might run against one of them should ask first: `spinuptui --help` lists `beacon send` only when Beacon is there. Check that rather than the version number, which doesn't tell you: the stable 1.2.0 release has no Beacon, while `1.2.0-alpha.1` does.

```sh
notify() {
  if spinuptui --help 2>/dev/null </dev/null | grep -q 'beacon send'; then
    spinuptui beacon send -- "$1"
    case $? in 0|2) return ;; esac   # 2 = tried and failed: don't double-send
  fi
  legacy_send "$1"                    # not installed, no Beacon, or not configured
}
```

## Let the pager answer you

Beacon can listen as well as page. With the listener running, you can message your bot from Telegram and the station answers:

- `/jobs` lists the station's scheduled jobs, soonest expiry first, and flags any that expire within 14 days. Recurring jobs that are about to expire (or expired in the last 14 days) get an **Extend 1 year** button. Tapping it does what `spinuptui scheduler extend <id> --by 1y` does, committed and pushed the same way.
- `/help` (or anything else) lists what the station answers.

Turn it on from the **Modules** tab: select Beacon and press `l`. It shows exactly what it installs, and `y` installs it. Or in a terminal:

```sh
spinuptui beacon listener install --plan    # what it would write and run
spinuptui beacon listener install --apply   # install it; it says hello on the pager when it's up
spinuptui beacon listener status            # is it answering?
spinuptui beacon listener uninstall --apply
```

On macOS the listener is a LaunchAgent that launchd restarts if it stops. It long-polls Telegram, about one request a minute when idle, and restarts itself after you upgrade SpinupTUI, so it never keeps running old code. Scheduler's tick checks every 5 minutes that it's still polling, and pages you once when it stops and once when it's back. To run it in the foreground instead, for testing, use `spinuptui beacon listen`.

**Only you can talk to it.** The listener answers only a private chat with the bot, and only when the message or tap comes from that chat's own user. Anything else is logged and ignored, without a reply, so someone who finds the bot learns nothing. It won't install on a channel that pages a group. Each update is acted on once: the listener records the update before acting on it, and every button works once, so a double tap can't extend a job twice. A command sent more than 10 minutes before the listener sees it (say, while the station was asleep) is dropped rather than answered late.

Telegram gives a bot's messages to one reader at a time, so Beacon setup stops the listener while it waits for your message and starts it again afterwards. The listener's log is `modules/beacon/listener.log` in the config directory.

## Team boards

A board is a Basecamp project's message board, for your own team's record. Sentinel posts incident reports there. It isn't a pager channel: it's never paged, and `beacon send` can't reach it. It needs the [Basecamp CLI](https://github.com/basecamp/basecamp-cli), logged in.

```sh
spinuptui beacon setup basecamp     # guided: who it posts as, project, who to mention, a test post
spinuptui beacon add basecamp board --project <id> --mention "Your Name"     # for scripts
```

A board posts as whichever account the CLI is logged in to, and most teams use a separate Basecamp user: see [who reports post as](sentinel.md#who-reports-post-as).

`add` saves the board even if the login can't be confirmed from your session, and says so. Over SSH or in an agent's shell that check often can't tell. Only a missing CLI stops it.

## Check on it

```sh
spinuptui beacon status    # channels (masked), the default, and the last send
spinuptui modules          # every module and its status (or the Modules tab, 6)
spinuptui beacon test      # send a test message naming this machine
spinuptui beacon remove pager
```

Every send is logged to `modules/beacon/send.log` inside SpinupTUI's config directory (`spinuptui where` prints it), one JSON line per send with the time, channel, outcome and the first 80 characters of the message. The log rotates at 1 MB.

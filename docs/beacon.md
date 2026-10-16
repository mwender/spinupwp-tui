# Beacon

Beacon is SpinupTUI's notification layer: one command that pages you, which any script, cron job, watcher or agent can call instead of carrying its own copy of "send a Telegram message". It is the first of SpinupTUI's modules, the features that keep working after the TUI is closed (`spinuptui modules` lists them).

Today Beacon has one kind of channel, Telegram, for the person who runs the fleet. More transports and a client-facing channel are planned; the design is in [2026-10-16_beacon-and-module-contract-spec.md](2026-10-16_beacon-and-module-contract-spec.md).

## Set up a channel

You need a Telegram bot token (from [@BotFather](https://t.me/BotFather)) and the chat id it should post to. Put both in a `KEY=VALUE` file:

```sh
TELEGRAM_BOT_TOKEN=123456789:AA…
TELEGRAM_CHAT_ID=-100…
```

Then add the channel:

```sh
spinuptui beacon add telegram pager --env-file ~/path/to/telegram.env
```

Beacon checks the token with Telegram and sends a "Beacon connected" message before it saves anything, so credentials that can't deliver are never stored. The credentials are saved in SpinupTUI's `config.json` (readable only by you, like the rest of its credentials), so the env file isn't needed afterwards. Secrets are never accepted as command-line arguments, where other users of the machine could see them in the process list.

The first channel you add is the default. Add `--default` to make a later one the default, or `--no-test` to skip the test message (the token is still checked).

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

`spinuptui` versions older than Beacon don't know the `beacon` subcommand and will try to open the dashboard instead of failing. A script that might run against an older install should check the version first:

```sh
notify() {
  if command -v spinuptui >/dev/null 2>&1 &&
     printf '%s\n%s\n' "1.2.0" "$(spinuptui --version 2>/dev/null)" | sort -V -C; then
    spinuptui beacon send --  "$1"
    case $? in 0|2) return ;; esac   # 2 = tried and failed: don't double-send
  fi
  legacy_send "$1"                    # not installed, too old, or not configured
}
```

## Check on it

```sh
spinuptui beacon status    # channels (masked), the default, and the last send
spinuptui beacon test      # send a test message naming this machine
spinuptui beacon remove pager
```

Every send is logged to `modules/beacon/send.log` inside SpinupTUI's config directory (`spinuptui where` prints it), one JSON line per send with the time, channel, outcome and the first 80 characters of the message. The log rotates at 1 MB.

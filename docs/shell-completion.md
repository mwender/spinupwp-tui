# Shell completion

Press Tab while typing a `spinuptui` command and your shell completes it: commands, subcommands and flags, the fixed values a flag takes (`--kind`, `--state`, `--late`…), and the values SpinupTUI can look up for you.

```text
$ spinuptui sch<Tab>                  →  spinuptui scheduler
$ spinuptui scheduler <Tab>           →  add, cancel, extend, list, run, show, …
$ spinuptui scheduler cancel nig<Tab> →  spinuptui scheduler cancel nightly-backup
$ spinuptui ssh exa<Tab>              →  spinuptui ssh example.com
```

## Turning it on

From 1.4.0, Homebrew installs the scripts for zsh, bash and fish, so there's nothing to do beyond having completion enabled in your shell (`compinit` in zsh, which most setups already run).

For a Bun or npm install, or a source checkout, add one line:

| Shell | Where | Line |
| --- | --- | --- |
| zsh | `~/.zshrc`, after `compinit` | `source <(spinuptui completion zsh)` |
| bash | `~/.bashrc` | `eval "$(spinuptui completion bash)"` |
| fish | run once | `spinuptui completion fish > ~/.config/fish/completions/spinuptui.fish` |

Open a new shell (or `source` the file) and it's live. Use `eval` rather than `source <(…)` in bash: the bash that ships with macOS (3.2) silently reads nothing from `source <(…)`.

## What it looks up

| After | It offers |
| --- | --- |
| `ssh`, `ssh-exec`, `siblings`, `incidents`, `pull files`, `pull db`, `--site`, `--domain` | your sites' domains, with the server each is on |
| `offline`, `online`, `--server` | your server names |
| `scheduler show`, `cancel`, `extend`, `run` | job ids, with source, kind and schedule |
| `--source`, `scheduler source remove`, `claim`, `release` | Scheduler sources |
| `--to`, `beacon remove` | Beacon channels |
| `todos show`, `done`, `snooze`, … | to-do ids, with state and title |
| `sentinel show`, `diagnose`, `post` | Sentinel incident ids |
| `sentinel expect check`, `remove`, `ack` | expectation ids |

Paths (`pull files <domain> [path]`, `--body-file`, `--workdir`…) use your shell's own file completion.

Domains and server names come from a small list, `site-index.json` in the config folder, which the dashboard rewrites each time it loads your sites. When that list is more than 6 hours old, the next Tab that needs it refreshes it from the SpinupWP API first. That takes about a second; if the API hasn't answered in 4 seconds, completion uses the old list (or offers no domains) rather than leave your prompt hanging. Everything else is read from disk on each Tab.

## How it works

The script your shell loads is a few lines: on Tab it runs `spinuptui __complete` with the words typed so far, and prints back what that returns. The answer comes from the same command table that `spinuptui -h` is rendered from (`src/lib/cliCommands.ts`), so a command added there shows up in both the help and completion. The script calls whichever `spinuptui` you typed, so a source checkout and an installed release each complete themselves.

You can try it without a shell:

```sh
spinuptui __complete scheduler cancel ""
```

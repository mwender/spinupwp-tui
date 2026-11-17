// The one table of SpinupTUI's commands: `spinuptui -h` is rendered from it, and
// shell completion (cliComplete.ts) walks it. Adding a subcommand or flag here
// puts it in both; cliCommands.test.ts checks the table against each module's
// own usage text, so a command missing from either side fails the tests.
//
// Kept free of imports from the rest of the app: completion runs on every Tab,
// and the help prints before anything else loads.

// Where a value's candidates come from. A literal list is offered as is; a named
// source is looked up when completing (see cliComplete.ts).
export type ValueSource =
  | readonly string[]
  | "site" // site domains (site-index.json, refreshed from the API when stale)
  | "server" // server names (same index)
  | "job" // Scheduler job ids
  | "source" // Scheduler source names
  | "channel" // Beacon channel names
  | "todo" // to-do ids
  | "incident" // Sentinel incident ids
  | "expectation" // Sentinel expectation ids
  | "file" // the shell's own file completion
  | "dir" // the shell's own directory completion

export interface Flag {
  name: string
  // Set for a flag that takes a value: the placeholder shown in help, e.g. "name".
  value?: string
  values?: ValueSource
  about?: string
}

export interface Arg {
  name: string
  values?: ValueSource
  // Repeats: every remaining positional completes from the same source.
  variadic?: boolean
}

export interface HelpEntry {
  // After "spinuptui ". Omitted: "<name> <sub> | <sub> | …" from the table.
  usage?: string
  about?: string
}

export interface Command {
  name: string
  about?: string
  args?: Arg[]
  flags?: Flag[]
  subs?: Command[]
  // Lines in `spinuptui -h`. Omitted: one generated line (see HelpEntry.usage).
  help?: HelpEntry[]
  // Run by the station itself (LaunchAgents, Scheduler jobs). Still completes,
  // but stays out of the generated help line.
  internal?: boolean
  // Not shown in `spinuptui -h` at all (still completes).
  hidden?: boolean
}

// Literal lists the table repeats rather than imports; the tests check them
// against the modules that own them.
export const SCHEDULER_KINDS = ["spinuptui", "script", "agent", "codex"] as const
export const TODO_KINDS = ["nginx", "monitoring", "plugin", "server", "sentinel", "decision", "watch", "note"] as const
export const EXPECT_TYPES = ["log-count", "load-shape", "cache-hit", "warmer", "status"] as const
export const SHELLS = ["zsh", "bash", "fish"] as const

const json: Flag = { name: "--json", about: "one result object on stdout" }
const server: Flag = { name: "--server", value: "name", values: "server", about: "pick the site on this server when a domain is on more than one" }
const plan: Flag = { name: "--plan", about: "show what would change" }
const apply: Flag = { name: "--apply", about: "make the change" }
const bin: Flag = { name: "--bin", value: "path", values: "file", about: "the spinuptui binary the agent should run" }
const schedSource: Flag = { name: "--source", value: "name", values: "source", about: "the Scheduler source (default: your default source)" }
const to: Flag = { name: "--to", value: "channel", values: "channel", about: "the Beacon channel" }
const job: Arg = { name: "id", values: "job" }
const todo: Arg = { name: "id", values: "todo" }
const incident: Arg = { name: "incident", values: "incident" }
const signAs: Flag = { name: "--as", value: "who", values: ["claude", "operator"], about: "sign the change as a Claude session" }

export const COMMANDS: Command[] = [
  { name: "login", about: "Set or update your saved API token", help: [{ usage: "login", about: "Set or update your saved API token" }] },
  { name: "where", about: "Print the config file path and token source", help: [{ usage: "where", about: "Print the config file path and token source" }] },
  {
    name: "ssh",
    about: "Print SSH access info for a site (JSON)",
    args: [{ name: "domain", values: "site" }],
    flags: [server],
    help: [{ usage: "ssh <domain> [--server <name>]", about: "Print SSH access info for a site (JSON)" }],
  },
  {
    name: "ssh-exec",
    about: "Run a read-only command over SSH (JSON)",
    args: [{ name: "domain", values: "site" }],
    flags: [server],
    help: [{ usage: "ssh-exec <domain> [--server <name>] -- <command>", about: "Run a read-only command over SSH (JSON); denies anything that looks like a remote write" }],
  },
  {
    name: "siblings",
    about: "List every site sharing a server with this one (JSON)",
    args: [{ name: "domain", values: "site" }],
    flags: [server, { name: "--probe", about: "also SSH into each to see which this device's key can read" }],
    help: [
      {
        usage: "siblings <domain> [--server <name>] [--probe]",
        about: "List every site sharing a server with this one (JSON), flagging the server's vanity host and which sites Kuma watches. --probe also SSHes into each to report which ones this device's key can actually read.",
      },
    ],
  },
  {
    name: "incidents",
    about: "Print Uptime Kuma down/up incidents (JSON)",
    args: [{ name: "domain", values: "site" }],
    flags: [
      { name: "--all", about: "the whole fleet" },
      { name: "--hours", value: "N", values: ["6", "24", "72", "168"], about: "how far back (default 24)" },
    ],
    help: [{ usage: "incidents <domain> | --all [--hours N]", about: "Print Uptime Kuma down/up incidents for a site or the whole fleet (JSON)" }],
  },
  {
    name: "pull",
    about: "Make or refresh a local copy of a site",
    subs: [
      {
        name: "files",
        about: "Clone a site's code to a new local working copy and link it",
        args: [{ name: "domain", values: "site" }, { name: "path", values: "dir" }],
        flags: [{ name: "--url", value: "local url", about: "the local copy's URL" }, server, json],
      },
      {
        name: "db",
        about: "Import production's database into the linked local copy",
        args: [{ name: "domain", values: "site" }],
        flags: [{ name: "--url", value: "local url", about: "the local copy's URL" }, server, { name: "--yes", about: "really overwrite the local database" }, json],
      },
    ],
    help: [
      {
        usage: "pull files <domain> [path] [--url <local url>] [--server <name>]",
        about: "Clone a site's code to a new local working copy and link it. Read-only on production; refuses a non-empty path. With exactly one localRoots entry configured, the path defaults to <that root>/<domain>.",
      },
      {
        usage: "pull db <domain> [--url <local url>] [--server <name>] --yes",
        about: 'Import production\'s database into the linked local copy, rewriting URLs. OVERWRITES your local database: needs both --yes and "localSync": true in the config.',
      },
    ],
  },
  {
    name: "offline",
    about: "Take sites offline at nginx",
    args: [{ name: "server", values: "server", variadic: true }],
    flags: [
      { name: "--all", about: "every server" },
      { name: "--site", value: "domain", values: "site", about: "just this site" },
      server,
      { name: "--yes", about: "do it (without, prints the plan)" },
      json,
    ],
    help: [
      { usage: "offline", about: "List servers with sites offline (--json)" },
      {
        usage: "offline <server>… | --all --yes",
        about: "Take every site on those servers offline: nginx stops answering, so no request reaches PHP. Files, databases and certificates are untouched. Without --yes, prints the plan and changes nothing.",
      },
      { usage: "offline --site <domain> [--server <name>] --yes", about: "Just that site. Its server's other sites (and PHP) stay up, so this protects the site, not the server." },
    ],
  },
  {
    name: "online",
    about: "Bring back the sites `offline` took down",
    args: [{ name: "server", values: "server", variadic: true }],
    flags: [
      { name: "--all", about: "every server" },
      { name: "--site", value: "domain", values: "site", about: "just this site" },
      server,
      { name: "--yes", about: "do it (without, prints the plan)" },
      json,
    ],
    help: [{ usage: "online <server>… | --all | --site <domain> --yes", about: "Bring back exactly the sites `offline` took down. Servers are matched by exact name, IP or id." }],
  },
  {
    name: "beacon",
    about: "Page yourself (Telegram, or a Basecamp board)",
    subs: [
      { name: "setup", about: "Guided Telegram setup (interactive)", args: [{ name: "name" }], subs: [{ name: "basecamp", about: "Guided setup for a team message board", args: [{ name: "name" }] }] },
      { name: "send", about: "Send a message", flags: [to, { name: "--silent", about: "no notification sound" }, json] },
      {
        name: "add",
        about: "Add a channel",
        subs: [
          {
            name: "telegram",
            about: "A Telegram chat",
            args: [{ name: "name" }],
            flags: [
              { name: "--env-file", value: "path", values: "file", about: "holds TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" },
              { name: "--default", about: "make it the default channel" },
              { name: "--no-test", about: "don't send a test message" },
            ],
          },
          {
            name: "basecamp",
            about: "A Basecamp message board",
            args: [{ name: "name" }],
            flags: [
              { name: "--project", value: "id", about: "the Basecamp project" },
              { name: "--mention", value: "person", about: "who to @mention" },
            ],
          },
        ],
      },
      { name: "remove", about: "Remove a channel", args: [{ name: "name", values: "channel" }] },
      { name: "test", about: "Send a test message", flags: [to, json] },
      { name: "status", about: "Show the channels", flags: [json] },
      { name: "listen", about: "Answer the operator: /jobs, button taps (foreground)", flags: [to] },
      {
        name: "listener",
        about: "Run `listen` as a LaunchAgent",
        subs: [
          { name: "install", about: "Install the listener", flags: [plan, apply, to, bin] },
          { name: "uninstall", about: "Remove the listener", flags: [plan, apply] },
          { name: "status", about: "Is it running?" },
          { name: "check", about: "Exit 1 when it isn't running" },
        ],
      },
    ],
    help: [
      { usage: "beacon setup", about: "Guided Telegram setup: make a bot, find your chat, send a test (interactive; also in the app's Modules tab, 6)" },
      {
        usage: "beacon send [--to <channel>] [--silent] [<message> | -]",
        about: "Page yourself through Beacon (Telegram). Reads the message from stdin when it's `-` or absent. Exit 0 sent, 1 not configured / usage, 2 delivery failed.",
      },
      { usage: "beacon add telegram <name> --env-file <path> [--default]", about: "Add a channel from a file holding TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; sends a test message before saving." },
      { usage: "beacon test | status | remove <name>" },
      { usage: "beacon listen | listener install --plan|--apply", about: "Let the pager answer: /jobs lists this station's scheduled jobs, with a button to extend any that expire soon" },
    ],
  },
  {
    name: "scheduler",
    about: "Run jobs later, on this station, and report through Beacon",
    subs: [
      { name: "status", about: "Is the Scheduler installed and ticking?", flags: [json] },
      { name: "list", about: "List the jobs", flags: [schedSource, { name: "--no-pull", about: "don't pull git sources first" }, json] },
      { name: "show", about: "Show a job and its last run", args: [job], flags: [schedSource] },
      {
        name: "add",
        about: "Queue a job",
        args: [{ name: "id" }],
        flags: [
          { name: "--kind", value: "kind", values: SCHEDULER_KINDS, about: "what the body is" },
          { name: "--when", value: "time", values: ["now"], about: '"YYYY-MM-DD HH:MM" or now' },
          { name: "--every", value: "schedule", values: ["30m", "6h", "daily 08:00", "weekdays 08:00", "mon,thu 08:00"], about: "a recurring schedule" },
          { name: "--expires", value: "date", about: "YYYY-MM-DD" },
          { name: "--created-by", value: "who", about: "who queued it" },
          schedSource,
          { name: "--workdir", value: "dir", values: "dir", about: "where it runs" },
          { name: "--timeout", value: "min", about: "minutes before it's stopped" },
          { name: "--notify", value: "how", values: ["beacon", "none"], about: "page the result?" },
          to,
          { name: "--late", value: "policy", values: ["run", "skip", "2h"], about: "what to do with a missed slot" },
          { name: "--agent", value: "agent", values: ["claude", "codex"], about: "agent jobs: which agent" },
          { name: "--allow", value: "tools", about: "agent jobs: tools it may use" },
          { name: "--add-dirs", value: "dirs", about: "agent jobs: extra directories it may read" },
          { name: "--model", value: "model", about: "agent jobs: the model" },
          { name: "--sandbox", value: "mode", about: "agent jobs: Codex's sandbox mode" },
          { name: "--body-file", value: "path", values: "file", about: "read the body from a file" },
          { name: "--prompt-file", value: "path", values: "file", about: "read the prompt from a file" },
          json,
        ],
      },
      {
        name: "extend",
        about: "Move a job's expiry later",
        args: [job],
        flags: [{ name: "--expires", value: "date", about: "YYYY-MM-DD" }, { name: "--by", value: "period", values: ["30d", "2w", "6m", "1y"], about: "from the current expiry" }, schedSource, json],
      },
      { name: "cancel", about: "Remove a job (its reports stay)", args: [job], flags: [schedSource, json] },
      { name: "run", about: "Run a job now, on this machine", args: [job], flags: [schedSource, json] },
      { name: "validate", about: "Check every job file", flags: [schedSource, json] },
      {
        name: "source",
        about: "Manage where jobs come from",
        subs: [
          { name: "add", about: "Add a source", args: [{ name: "name" }, { name: "path", values: "dir" }], flags: [{ name: "--default", about: "make it the default source" }] },
          { name: "remove", about: "Remove a source", args: [{ name: "name", values: "source" }] },
          { name: "claim", about: "Run this git source from this station", args: [{ name: "name", values: "source" }] },
          { name: "release", about: "Stop running it here; another station takes it", args: [{ name: "name", values: "source" }] },
        ],
      },
      { name: "tick", about: "Run whatever is due (the LaunchAgent runs this)", internal: true, flags: [{ name: "--here", about: "even if another station claims the source" }, json] },
      { name: "install", about: "Install the Scheduler's LaunchAgent", flags: [plan, apply, bin, json] },
      { name: "uninstall", about: "Remove the Scheduler's LaunchAgent", flags: [plan, apply, json] },
      {
        name: "heartbeat",
        about: "Ping an Uptime Kuma push monitor every tick",
        subs: [
          { name: "setup", about: "Create the push monitor", flags: [plan, apply, { name: "--notify", value: "name", about: "the Kuma notification to attach" }, json] },
          { name: "set", about: "Use an existing push URL", args: [{ name: "kuma-push-url" }] },
          { name: "test", about: "Send one ping" },
          { name: "remove", about: "Stop pinging" },
        ],
      },
    ],
    help: [
      {
        usage: "scheduler add <id> --kind spinuptui|script|agent --when <time> | --every <schedule> --expires <date> --created-by <who> -- <body>",
        about: "Queue a follow-up for this station to run later and report on through Beacon",
      },
      { about: "Manage the jobs; `spinuptui scheduler` prints every option" },
    ],
  },
  {
    name: "sentinel",
    about: "Watch the fleet, work out what broke, write it up",
    subs: [
      {
        name: "setup",
        about: "Set Sentinel up",
        flags: [
          plan,
          apply,
          { name: "--shadow", about: "watch without acting" },
          { name: "--agent", value: "agent", values: ["claude", "codex", "none"], about: "who diagnoses" },
          { name: "--workspace", value: "dir", values: "dir", about: "where its reports go" },
          { name: "--report-to", value: "board", values: "channel", about: "the board reports are posted to" },
          json,
        ],
      },
      { name: "attach", about: "Adopt an existing Kuma's monitors", flags: [plan, apply, { name: "--include-likely", about: "also monitors that probably match" }, json] },
      { name: "status", about: "Is it watching?", flags: [json] },
      { name: "tick", about: "One check of Kuma (Scheduler runs this)", internal: true, flags: [{ name: "--dry-run", about: "change nothing" }, json] },
      { name: "worker", about: "Run queued diagnoses (Scheduler runs this)", internal: true, flags: [json] },
      { name: "digest", about: "The daily digest (Scheduler runs this)", internal: true, flags: [{ name: "--dry-run", about: "change nothing" }, json] },
      { name: "list", about: "List incidents", flags: [{ name: "--open", about: "only open ones" }, json] },
      { name: "show", about: "Show an incident", args: [incident] },
      { name: "diagnose", about: "Queue a diagnosis; the next tick starts it", args: [incident], flags: [json] },
      { name: "post", about: "Post an incident's report to the board", args: [incident], flags: [json] },
      { name: "pause", about: "Stop acting on events, up to 7d", flags: [{ name: "--for", value: "duration", values: ["30m", "2h", "1d", "7d"], about: "how long" }, json] },
      { name: "resume", about: "Act on events again", flags: [json] },
      { name: "go-live", about: "Leave shadow mode", flags: [{ name: "--since", value: "time", about: '"YYYY-MM-DD HH:MM:SS" (UTC)' }, json] },
      {
        name: "expect",
        about: "Things that should stay true",
        subs: [
          { name: "list", about: "List expectations", flags: [json] },
          {
            name: "add",
            about: "Add one",
            args: [{ name: "id" }],
            flags: [
              { name: "--type", value: "type", values: EXPECT_TYPES, about: "what kind of check" },
              { name: "--domain", value: "domain", values: "site", about: "the site" },
              { name: "--label", value: "label" },
              { name: "--note", value: "note" },
              { name: "--expires", value: "date", about: "YYYY-MM-DD" },
              { name: "--match", value: "text", about: "log-count: what to count" },
              { name: "--min", value: "N", about: "log-count: at least this many" },
              { name: "--trend", about: "log-count: watch the trend" },
              { name: "--threshold", value: "N", about: "load-shape" },
              { name: "--host", value: "host", about: "cache-hit: the canonical host" },
              { name: "--paths", value: "paths", about: "cache-hit: e.g. /,/?one=param" },
              { name: "--log-glob", value: "path", about: "warmer" },
              { name: "--url", value: "url", about: "status" },
              { name: "--expect", value: "code", values: ["200", "301", "302", "404", "410"], about: "status: the HTTP code" },
              json,
            ],
          },
          { name: "check", about: "Run one now", args: [{ name: "id", values: "expectation" }], flags: [json] },
          { name: "remove", about: "Remove one", args: [{ name: "id", values: "expectation" }], flags: [json] },
          { name: "ack", about: "Acknowledge a failing one", args: [{ name: "id", values: "expectation" }], flags: [json] },
        ],
      },
    ],
    help: [{ about: "Watch the fleet, work out what broke, write it up (runs as Scheduler jobs; see docs/sentinel.md)" }],
  },
  {
    name: "todos",
    about: "Work the to-dos Sentinel's reports recommend",
    subs: [
      {
        name: "list",
        about: "List to-dos",
        flags: [
          { name: "--state", value: "state", values: ["open", "done", "wontfix", "snoozed", "all"], about: "default open" },
          { name: "--kind", value: "kind", values: TODO_KINDS },
          { name: "--site", value: "domain", values: "site" },
          { name: "--server", value: "host", values: "server" },
          json,
        ],
      },
      { name: "show", about: "Show one", args: [todo], flags: [json] },
      { name: "done", about: "Mark it done", args: [todo], flags: [signAs, json] },
      { name: "wontfix", about: "Close it with a reason Sentinel reads", args: [todo], flags: [json] },
      { name: "snooze", about: "Hide it until a date", args: [todo], flags: [{ name: "--until", value: "date", about: "YYYY-MM-DD" }, json] },
      { name: "comment", about: "Add a comment", args: [todo], flags: [signAs, json] },
      { name: "reopen", about: "Open it again", args: [todo], flags: [signAs, json] },
      { name: "session", about: "Talk it through with Claude", args: [todo], flags: [json] },
      { name: "import", about: "Record the to-dos block left in a report", args: [{ name: "report", values: "file" }], flags: [{ name: "--force", about: "even if it was imported before" }, json] },
    ],
    help: [{ about: "Work the to-dos Sentinel's reports recommend" }],
  },
  {
    name: "home",
    about: "Where the SpinupTUI folder (your jobs and reports) is",
    flags: [json],
    subs: [
      {
        name: "sync",
        about: "Share the folder through a private git repository",
        flags: [
          plan,
          apply,
          { name: "--github", value: "name", about: "create a private GitHub repository for it (needs gh)" },
          { name: "--remote", value: "url", about: "push it to an empty private repository you made" },
          { name: "--clone", value: "url", about: "on another machine: set the same folder up here" },
          json,
        ],
      },
    ],
    help: [
      { usage: "home", about: "Where the SpinupTUI folder (your jobs and reports) is" },
      { usage: "home sync --plan|--apply --github <name> | --remote <url> | --clone <url>", about: "Share that folder across machines through a private git repository, or set it up from one on a second machine" },
    ],
  },
  { name: "modules", about: "List SpinupTUI's modules and their status", flags: [json], help: [{ usage: "modules", about: "List SpinupTUI's modules and their status (--json)" }] },
  {
    name: "completion",
    about: "Print a shell completion script",
    args: [{ name: "shell", values: SHELLS }],
    help: [{ usage: "completion zsh|bash|fish", about: "Print a tab-completion script for your shell (see docs/shell-completion.md)" }],
  },
  { name: "help", about: "Show this help", hidden: true },
  { name: "version", about: "Print the version", hidden: true },
]

export const GLOBAL_FLAGS: Flag[] = [
  { name: "--help", about: "Show this help" },
  { name: "--version", about: "Print the version" },
]

export function findCommand(path: string[], table: Command[] = COMMANDS): Command | null {
  let list = table
  let found: Command | null = null
  for (const name of path) {
    found = list.find((c) => c.name === name) ?? null
    if (!found) return null
    list = found.subs ?? []
  }
  return found
}

// ---- help -------------------------------------------------------------------------

const WIDTH = 79
const DESC_COL = 23 // where descriptions start, as "  spinuptui " is 12 wide

// Greedy word wrap of `text` into lines no wider than `width`.
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

// A usage line too long for one row breaks before a " | " or a "[" / "--",
// continuing under the first argument.
function wrapUsage(usage: string): string[] {
  const first = `  spinuptui ${usage}`
  if (first.length <= WIDTH) return [first]
  const head = usage.split(" ").slice(0, 2).join(" ")
  const indent = " ".repeat(12 + head.length + 1)
  const parts = usage.slice(head.length + 1).split(/ (?=\| |\[|--)/)
  const lines: string[] = []
  let line = `  spinuptui ${head}`
  for (const part of parts) {
    if (line.length + 1 + part.length > WIDTH && line !== `  spinuptui ${head}`) {
      lines.push(line)
      line = indent + part
    } else line = `${line} ${part}`
  }
  lines.push(line)
  return lines
}

export function generatedUsage(cmd: Command): string {
  const subs = (cmd.subs ?? []).filter((s) => !s.internal && !s.hidden).map((s) => s.name)
  return subs.length ? `${cmd.name} ${subs.join(" | ")}` : cmd.name
}

export function renderHelpEntry(cmd: Command, entry: HelpEntry): string[] {
  const usage = entry.usage ?? generatedUsage(cmd)
  const lines = wrapUsage(usage)
  if (!entry.about) return lines
  const pad = " ".repeat(DESC_COL)
  const last = lines[lines.length - 1]!
  // A short usage takes its description on the same row, as `spinuptui where`.
  if (lines.length === 1 && last.length <= DESC_COL - 2) {
    const [firstLine, ...rest] = wrap(entry.about, WIDTH - DESC_COL)
    return [last.padEnd(DESC_COL) + firstLine, ...rest.map((l) => pad + l)]
  }
  return [...lines, ...wrap(entry.about, WIDTH - DESC_COL).map((l) => pad + l)]
}

export function renderCommandList(table: Command[] = COMMANDS): string {
  const lines: string[] = [`  spinuptui`.padEnd(DESC_COL) + "Launch the dashboard"]
  for (const cmd of table) {
    if (cmd.hidden) continue
    for (const entry of cmd.help ?? [{ about: cmd.about }]) lines.push(...renderHelpEntry(cmd, entry))
  }
  lines.push(`  spinuptui --version`.padEnd(DESC_COL) + "Print the version")
  lines.push(`  spinuptui --help`.padEnd(DESC_COL) + "Show this help")
  return lines.join("\n")
}

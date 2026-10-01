// Read-only allowlist for `spinuptui ssh-exec`. Ported from the WordPress Site
// Diagnostics playbook's Claude-Code-specific PreToolUse hook (guard-ssh-hook.py),
// which classified raw `ssh ...` Bash invocations for an unattended agent. Moving
// this into SpinupTUI itself means the guarantee holds for any agent that's
// configured to touch servers only through `ssh-exec`, not just Claude Code.

const DANGEROUS_PATTERNS: RegExp[] = [
  /\b(rm|mv|chmod|chown|reboot|shutdown|kill|truncate)\b/i,
  /systemctl\s+(restart|stop|reload)\b/i,
  /service\s+\S+\s+restart\b/i,
  /crontab\s+-[re]\b/i,
  /sed\s+-i\b/i,
  /\b(DROP\s+TABLE|INSERT\s+INTO|DELETE\s+FROM)\b/i,
  /UPDATE\s+\S+\s+SET\b/i,
  /\b(apt(-get)?|yum|brew)\s+install\b/i,
]

// The Python hook's original check `(?<!=)>{1,2}` denied any `>`/`>>` unless
// immediately preceded by `=` — which wrongly caught `2>/dev/null`/`2>&1` (the
// character before `>` there is the fd digit, not `=`). Fix: strip known-safe
// redirects (discard to /dev/null, or an fd-to-fd dup like `2>&1`) first, then
// flag anything that still looks like a write to a real path.
function hasUnsafeRedirect(cmd: string): boolean {
  const stripped = cmd.replace(/\d?>{1,2}\s*(\/dev\/null\b|&\d+)/g, "")
  return />/.test(stripped)
}

// redis-cli has a verb grammar a deny-list can't enumerate (CONFIG SET, FLUSHALL,
// CLIENT PAUSE, plain SET/DEL/EXPIRE, …), and generic patterns like /\bset\b/
// would collide with awk in ordinary log analysis. So it is allowlisted instead:
// every redis-cli in the command must name a known read, and anything else is
// denied — an unknown verb, an unknown flag (--pipe, --eval, --rdb, --cluster and
// --lru-test all write), or no verb at all (bare redis-cli takes commands on stdin).
// Deliberately left out though read-only: KEYS and MONITOR (both can stall a busy
// instance) and GET (dumps cached values into the log).
const REDIS_READ_VERBS = new Set([
  "ping", "info", "dbsize", "lastsave", "time", "role",
  "scan", "type", "ttl", "pttl", "exists", "strlen",
])
const REDIS_READ_SUBVERBS: Record<string, Set<string>> = {
  config: new Set(["get"]),
  memory: new Set(["doctor", "stats", "usage", "malloc-stats"]),
  latency: new Set(["latest", "history", "doctor"]),
  slowlog: new Set(["get", "len"]),
  client: new Set(["list", "info"]),
}
const REDIS_VALUE_FLAGS = new Set(["-h", "-p", "-s", "-a", "-n", "-u", "--user", "--pass"])
const REDIS_BARE_FLAGS = new Set(["--no-auth-warning", "--raw", "--no-raw", "--tls", "-c", "-e", "-2", "-3"])

// Shared by the per-tool allowlists below. A segment is what follows the tool
// name up to the next shell operator.
const SEGMENT = "([^|;&()`<>\\n]*)"
// Drop a quote pair around a token, and a stray closing quote left by an
// enclosing `ssh host '…'` / `bash -c "…"`.
const clean = (t: string) => t.replace(/^(['"])(.*)\1$/, "$2").replace(/['"]+$/, "").toLowerCase()
// A token that opens a quote it doesn't close (`-a 'pw ping' flushall`) would
// shift which later token we read as the verb.
const hasOpenQuote = (t: string) => /['"]/.test(t) && !/^[^'"]*(['"])[^'"]*\1$/.test(t)

// Returns why the command is unsafe, or null. Looks at every `redis-cli` in the
// string, wherever it appears — including inside `bash -c '…'`, `sudo`, `xargs`,
// or a grep pattern — so a mention that isn't an invocation (`which redis-cli`)
// is denied too; that is the price of not having to recognise command position.
function unsafeRedisCli(cmd: string): string | null {
  for (const m of cmd.matchAll(new RegExp(`\\bredis-cli\\b${SEGMENT}`, "g"))) {
    const tokens = (m[1] ?? "").trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 1 && /^(-v|--version)$/.test(clean(tokens[0]!))) continue
    let i = 0
    for (; i < tokens.length; i++) {
      const flag = clean(tokens[i]!)
      if (!flag.startsWith("-")) break
      if (REDIS_BARE_FLAGS.has(flag)) continue
      if (!REDIS_VALUE_FLAGS.has(flag)) return `redis-cli option \`${flag}\` is not on the read-only allowlist`
      if (hasOpenQuote(tokens[++i] ?? "")) return "redis-cli option value has quoting this guard can't read safely"
    }
    const verb = clean(tokens[i] ?? "")
    if (!verb) return "redis-cli with no command reads commands from stdin"
    if (REDIS_READ_VERBS.has(verb)) continue
    const sub = clean(tokens[i + 1] ?? "")
    if (REDIS_READ_SUBVERBS[verb]?.has(sub)) continue
    return `redis-cli \`${[verb, sub].filter(Boolean).join(" ")}\` is not on the read-only allowlist`
  }
  return null
}

// WP-CLI gets the same treatment: the deny patterns this replaces listed a dozen
// writes and missed the rest (`transient delete`, `search-replace`, `eval`, …),
// while blanket-denying reads like `wp user list`. Each entry is a full command
// path. Left out on purpose: `db query`/`eval`/`shell` (arbitrary SQL or PHP),
// `db export` (writes a file), `config get|list` (prints the DB password) and
// `cron test` (spawns a cron run).
const WP_READ_COMMANDS = new Set([
  "core version", "core is-installed", "core verify-checksums", "core check-update",
  "plugin list", "plugin get", "plugin status", "plugin is-active", "plugin is-installed", "plugin path", "plugin verify-checksums",
  "theme list", "theme get", "theme status", "theme is-active", "theme is-installed", "theme path",
  "option get", "option list", "transient get", "transient list", "cache type",
  "user list", "user get", "user list-caps", "role list", "cap list",
  "post list", "post get", "site list", "rewrite list",
  "cron event list", "cron schedule list",
  "db size", "db tables", "db prefix", "db check",
  "config path", "config has", "maintenance-mode status", "maintenance-mode is-active",
  "cli version", "cli info", "cli check-update",
  "doctor list", "doctor check", "profile stage", "profile hook",
])
// Global flags that run code or send the command somewhere else. Per-command
// flags (--format, --field, --status, …) are too many to allowlist.
const WP_UNSAFE_FLAGS = /(^|\s)['"]?--(exec|require|ssh|http)\b/

// Unlike redis-cli, `wp` is only treated as an invocation when it stands alone
// and is followed by a word — a bare `wp` just prints help, and this keeps paths
// (`wp-content`, Bedrock's `web/wp`) from tripping it.
function unsafeWpCli(cmd: string): string | null {
  // `wp 2>/dev/null plugin delete x` must not end the segment at the redirect.
  const stripped = cmd.replace(/\d?>{1,2}\s*(\/dev\/null\b|&\d+)/g, "")
  for (const m of stripped.matchAll(new RegExp(`(?<![\\w.$-])wp(?:-cli\\.phar)?(?=\\s)${SEGMENT}(.?)`, "gs"))) {
    const segment = m[1] ?? ""
    if (WP_UNSAFE_FLAGS.test(segment)) return "wp --exec/--require/--ssh/--http can run code or target another host"
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    let i = 0
    for (; i < tokens.length && tokens[i]!.replace(/^['"]/, "").startsWith("-"); i++) {
      // A quote that is only trailing is an enclosing `bash -c '…'` closing after a
      // final flag (`bash -c 'wp --info'`), not an opened value.
      if (hasOpenQuote(tokens[i]!) && /['"]/.test(tokens[i]!.replace(/['"]+$/, ""))) return "wp option value has quoting this guard can't read safely"
    }
    const words: string[] = []
    for (; i < tokens.length && words.length < 3; i++) {
      const word = clean(tokens[i]!)
      if (word.startsWith("-")) break
      if (word) words.push(word)
    }
    if (words.length === 0) {
      // `wp </dev/stdin plugin delete` — the command sits past a redirect we stopped at.
      if (m[2] === "<" || m[2] === ">") return "wp followed by a redirect hides its command from this guard"
      continue
    }
    if ([3, 2].some((n) => words.length >= n && WP_READ_COMMANDS.has(words.slice(0, n).join(" ")))) continue
    return `wp \`${words.slice(0, 2).join(" ")}\` is not on the read-only allowlist`
  }
  return null
}

export interface SshCommandVerdict {
  decision: "allow" | "deny"
  reason: string
}

export function classifySshCommand(cmd: string): SshCommandVerdict {
  const unsafeTool = unsafeRedisCli(cmd) ?? unsafeWpCli(cmd)
  if (unsafeTool) {
    return {
      decision: "deny",
      reason: `${unsafeTool} — spinuptui ssh-exec only runs read-only diagnostic commands.`,
    }
  }
  if (DANGEROUS_PATTERNS.some((re) => re.test(cmd)) || hasUnsafeRedirect(cmd)) {
    return {
      decision: "deny",
      reason: "This command looks like a remote write/restart/destructive action — spinuptui ssh-exec only runs read-only diagnostic commands.",
    }
  }
  return {
    decision: "allow",
    reason: "Read-only diagnostic command, no write/restart/destructive pattern detected.",
  }
}

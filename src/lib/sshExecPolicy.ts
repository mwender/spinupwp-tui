// Read-only allowlist for `spinuptui ssh-exec`. Ported from the WordPress Site
// Diagnostics playbook's Claude-Code-specific PreToolUse hook (guard-ssh-hook.py),
// which classified raw `ssh ...` Bash invocations for an unattended agent. Moving
// this into SpinupTUI itself means the guarantee holds for any agent that's
// configured to touch servers only through `ssh-exec`, not just Claude Code.

const DANGEROUS_PATTERNS: RegExp[] = [
  /\b(rm|mv|chmod|chown|reboot|shutdown|kill|truncate)\b/i,
  /systemctl\s+(restart|stop|reload)\b/i,
  /service\s+\S+\s+restart\b/i,
  /wp\s+plugin\s+(activate|deactivate|install|update|delete)\b/i,
  /wp\s+theme\s+(activate|delete|install)\b/i,
  /wp\s+db\s+(query|import|reset)\b/i,
  /wp\s+option\s+(update|delete|add)\b/i,
  /wp\s+user\b/i,
  /wp\s+core\s+(update|install)\b/i,
  /wp\s+(rewrite\s+flush|cache\s+flush)\b/i,
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

export interface SshCommandVerdict {
  decision: "allow" | "deny"
  reason: string
}

export function classifySshCommand(cmd: string): SshCommandVerdict {
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

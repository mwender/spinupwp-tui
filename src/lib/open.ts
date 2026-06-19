// Open a URL in the user's default browser, cross-platform. Best-effort; never throws.

export function openUrl(url: string): void {
  try {
    const platform = process.platform
    const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
    const args = platform === "win32" ? ["/c", "start", "", url] : [url]
    Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  } catch {
    // ignore — opening a browser is a convenience, not critical
  }
}

// macOS has no registered "default terminal" role (unlike the default browser),
// so we can't ask LaunchServices which terminal to use. The best proxy is
// $TERM_PROGRAM — the terminal that launched this process sets it — which works
// well because the app is normally started via the `spinup` command from the
// user's terminal of choice. This maps those values to the app name `open -a`
// expects. Unknown/unset → Terminal.
const TERM_PROGRAM_APP: Record<string, string> = {
  "iTerm.app": "iTerm",
  Apple_Terminal: "Terminal",
  WarpTerminal: "Warp",
  ghostty: "Ghostty",
  WezTerm: "WezTerm",
  Hyper: "Hyper",
  Tabby: "Tabby",
  vscode: "Visual Studio Code",
}

// Resolve which macOS terminal app to open. An explicit config override wins;
// otherwise infer from $TERM_PROGRAM; otherwise fall back to Terminal.
export function resolveTerminalApp(override?: string | null): string {
  const o = override?.trim()
  if (o) return o
  const tp = process.env.TERM_PROGRAM?.trim()
  return (tp && TERM_PROGRAM_APP[tp]) || "Terminal"
}

// The ssh command line for a site shell (adds -p when the port isn't the default).
export function sshCommand(user: string, host: string, port?: number | null): string {
  return port && port !== 22 ? `ssh -p ${port} ${user}@${host}` : `ssh ${user}@${host}`
}

// Open a new terminal window already running `ssh user@host`. Best-effort; never
// throws. macOS scripts the user's terminal (iTerm or, as a reliable fallback for
// any other, Terminal); Linux/Windows do their best.
export function openSshSession(user: string, host: string, port?: number | null, terminalApp?: string | null): void {
  const cmd = sshCommand(user, host, port)
  try {
    const platform = process.platform
    if (platform === "darwin") {
      const esc = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      const app = resolveTerminalApp(terminalApp)
      const args =
        app === "iTerm"
          ? ["-e", `tell application "iTerm"\ncreate window with default profile command "${esc}"\nactivate\nend tell`]
          : ["-e", `tell application "Terminal" to do script "${esc}"`, "-e", `tell application "Terminal" to activate`]
      Bun.spawn(["osascript", ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    } else if (platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", "cmd", "/k", cmd], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    } else {
      Bun.spawn(["x-terminal-emulator", "-e", cmd], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    }
  } catch {
    // ignore — opening a shell is a convenience, not critical
  }
}

// Open a terminal window at the given directory (where the user runs editor /
// composer / git themselves). Best-effort; never throws. macOS opens the user's
// terminal (see resolveTerminalApp); Linux tries common emulators; Windows opens
// cmd in the directory.
export function openTerminalAt(dir: string, terminalApp?: string | null): void {
  try {
    const platform = process.platform
    if (platform === "darwin") {
      Bun.spawn(["open", "-a", resolveTerminalApp(terminalApp), dir], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    } else if (platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", "cmd", "/k", `cd /d ${dir}`], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    } else {
      // Try a few common terminal emulators; the first that exists wins.
      Bun.spawn(["x-terminal-emulator", "--working-directory", dir], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    }
  } catch {
    // ignore — opening a terminal is a convenience, not critical
  }
}

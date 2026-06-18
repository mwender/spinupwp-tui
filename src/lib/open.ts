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

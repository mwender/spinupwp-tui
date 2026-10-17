// Minimal line prompts for interactive CLI subcommands (not the TUI). Prompts go
// to stderr so stdout stays clean. `hidden` reads in raw mode and echoes a dot
// per character, for secrets: they never appear on screen or in argv.

export class PromptCancelled extends Error {}

export function readLine(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const stdin = process.stdin
  process.stderr.write(question)
  return new Promise((resolve, reject) => {
    let buf = ""
    const raw = Boolean(stdin.isTTY)
    if (raw) stdin.setRawMode(true)
    stdin.resume()
    const done = (err: Error | null) => {
      stdin.off("data", onData)
      if (raw) stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write("\n")
      if (err) reject(err)
      else resolve(buf)
    }
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\u0003" || ch === "\u0004") return done(new PromptCancelled("cancelled"))
        if (ch === "\r" || ch === "\n") return done(null)
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length) {
            buf = buf.slice(0, -1)
            if (raw) process.stderr.write("\b \b")
          }
          continue
        }
        if (ch < " ") continue
        buf += ch
        if (raw) process.stderr.write(opts.hidden ? "•" : ch)
      }
    }
    stdin.on("data", onData)
  })
}

export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const answer = (await readLine(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase()
  if (!answer) return defaultYes
  return answer === "y" || answer === "yes"
}

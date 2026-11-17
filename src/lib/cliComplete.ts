// Shell completion. `spinuptui completion zsh|bash|fish` prints a small script
// for that shell; on Tab the script calls `spinuptui __complete <words…>` with
// the words typed so far (the last one possibly empty, the word being
// completed), and this prints the candidates, one per line as
// "value<TAB>description". The shell filters them by what's typed. A first line
// of ":file" or ":dir" asks the shell for its own path completion instead.
//
// The words are walked against the command table (cliCommands.ts), so anything
// in `spinuptui -h` completes, and nothing has its own completion code.

import { COMMANDS, GLOBAL_FLAGS, type Command, type Flag, type ValueSource } from "./cliCommands.ts"

export interface Candidate {
  value: string
  about?: string
}

export type Completion = { kind: "values"; items: Candidate[] } | { kind: "file" } | { kind: "dir" } | { kind: "none" }

export type Resolver = (source: Exclude<ValueSource, readonly string[]>) => Promise<Candidate[]>

function flagsOf(cmd: Command | null): Flag[] {
  return cmd ? (cmd.flags ?? []) : GLOBAL_FLAGS
}

async function fromSource(source: ValueSource | undefined, resolve: Resolver): Promise<Completion> {
  if (!source) return { kind: "none" }
  if (typeof source !== "string") return { kind: "values", items: source.map((value) => ({ value })) }
  if (source === "file") return { kind: "file" }
  if (source === "dir") return { kind: "dir" }
  return { kind: "values", items: await resolve(source) }
}

// `words` are the arguments after "spinuptui", ending with the word being
// completed ("" right after a space).
export async function complete(words: string[], resolve: Resolver, table: Command[] = COMMANDS): Promise<Completion> {
  const done = words.slice(0, -1)
  const current = words[words.length - 1] ?? ""
  let cmd: Command | null = null
  let subs: Command[] = table
  let positional = 0
  const used = new Set<string>()
  let pendingFlag: Flag | null = null

  for (const word of done) {
    if (pendingFlag) {
      pendingFlag = null
      continue
    }
    // After "--" comes a command or message of the user's own (ssh-exec,
    // scheduler add): nothing to offer.
    if (word === "--") return { kind: "none" }
    if (word.startsWith("-")) {
      used.add(word)
      const flag = flagsOf(cmd).find((f) => f.name === word)
      if (flag?.value) pendingFlag = flag
      continue
    }
    const sub = positional === 0 ? subs.find((s) => s.name === word) : undefined
    if (sub) {
      cmd = sub
      subs = sub.subs ?? []
      continue
    }
    positional++
  }

  if (pendingFlag) return fromSource(pendingFlag.values, resolve)

  const flagItems = (): Candidate[] => flagsOf(cmd).filter((f) => !used.has(f.name)).map((f) => ({ value: f.name, about: f.about }))
  if (current.startsWith("-")) return { kind: "values", items: flagItems() }

  if (positional === 0 && subs.length) {
    return { kind: "values", items: subs.map((s) => ({ value: s.name, about: s.about })) }
  }
  const args = cmd?.args ?? []
  const last = args[args.length - 1]
  const arg = args[positional] ?? (last?.variadic ? last : undefined)
  if (arg?.values) return fromSource(arg.values, resolve)
  // A free-text argument (a name, a message) has nothing to offer; once the
  // arguments are filled, offer the flags.
  if (arg) return { kind: "none" }
  return { kind: "values", items: flagItems() }
}

export function formatCompletion(c: Completion): string {
  if (c.kind === "file") return ":file\n"
  if (c.kind === "dir") return ":dir\n"
  if (c.kind === "none") return ""
  const clean = (s: string) => s.replace(/[\t\n]/g, " ")
  return c.items.map((i) => (i.about ? `${clean(i.value)}\t${clean(i.about)}` : clean(i.value))).join("\n") + (c.items.length ? "\n" : "")
}

// ---- where dynamic values come from -----------------------------------------------

// Every lookup is best effort: a missing config, folder or token means no
// candidates, never an error on the user's command line.
export const resolveFromDisk: Resolver = async (source) => {
  try {
    switch (source) {
      case "site":
      case "server": {
        const index = await siteIndex()
        if (!index) return []
        return source === "site" ? index.sites.map((s) => ({ value: s.domain, about: s.server })) : index.servers.map((value) => ({ value }))
      }
      case "job": {
        const { loadConfig } = await import("../config.ts")
        const { listSources, loadJobs } = await import("./schedulerJobs.ts")
        const { existsSync } = await import("node:fs")
        const out: Candidate[] = []
        for (const s of listSources(loadConfig())) {
          if (!existsSync(s.path)) continue
          for (const j of loadJobs(s)) if (j.header.id) out.push({ value: j.header.id, about: [s.name, j.header.kind, j.header.when ?? (j.header.every ? `every ${j.header.every}` : "")].filter(Boolean).join(" · ") })
        }
        return out
      }
      case "source": {
        const { loadConfig } = await import("../config.ts")
        const { listSources } = await import("./schedulerJobs.ts")
        return listSources(loadConfig()).map((s) => ({ value: s.name, about: s.path }))
      }
      case "channel": {
        const { loadConfig } = await import("../config.ts")
        const { beaconFromConfig } = await import("./beacon.ts")
        return beaconFromConfig(loadConfig()).channels.map((c) => ({ value: c.name, about: c.channel.type }))
      }
      case "todo": {
        const { readLedger, effectiveState, sortById } = await import("./todos.ts")
        const now = new Date()
        return [...readLedger().items.values()].sort(sortById).map((t) => ({ value: t.id, about: `${effectiveState(t, now)} · ${t.title}` }))
      }
      case "incident": {
        const { loadIncidents } = await import("./sentinelState.ts")
        return loadIncidents().map((i) => ({ value: i.id, about: `${i.key} · ${i.state}` }))
      }
      case "expectation": {
        const { loadExpectations } = await import("./sentinelExpect.ts")
        return loadExpectations().map((e) => ({ value: e.id, about: e.type }))
      }
    }
  } catch {
    return []
  }
  return []
}

// The site index, refreshed from the API when it's missing or stale. A refresh
// that takes longer than a few seconds is abandoned for the stale copy (or
// nothing): a Tab that hangs is worse than one that offers no domains.
async function siteIndex() {
  const { readSiteIndex, isFresh, saveSiteIndex } = await import("./siteIndex.ts")
  const index = readSiteIndex()
  if (isFresh(index)) return index
  try {
    const { loadConfig } = await import("../config.ts")
    const { SpinupWPClient } = await import("../api/client.ts")
    const cfg = loadConfig()
    if (!cfg.token) return index
    const client = new SpinupWPClient(cfg)
    const fetched = await Promise.race([
      Promise.all([client.listServers(), client.listSites()]),
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ])
    if (!fetched) return index
    saveSiteIndex(fetched[0], fetched[1])
    return readSiteIndex()
  } catch {
    return index
  }
}

// ---- the shell scripts ------------------------------------------------------------

// Each script calls back into whichever spinuptui the user typed (its first
// word), so a dev build and an installed release each complete themselves.

const ZSH = `#compdef spinuptui
# spinuptui shell completion for zsh. Install: see \`spinuptui completion --help\`.
_spinuptui() {
  local -a out items
  local line value desc
  out=("\${(@f)$(\${words[1]} __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  case "\${out[1]}" in
    :file) _files; return ;;
    :dir) _files -/; return ;;
  esac
  for line in "\${out[@]}"; do
    [[ -z "$line" ]] && continue
    value="\${line%%$'\\t'*}"
    value="\${value//:/\\\\:}"
    if [[ "$line" == *$'\\t'* ]]; then desc="\${line#*$'\\t'}"; items+=("$value:$desc"); else items+=("$value"); fi
  done
  (( \${#items} )) && _describe -t values 'spinuptui' items
}
if [[ "\${funcstack[1]}" == "_spinuptui" ]]; then
  _spinuptui "$@"
else
  compdef _spinuptui spinuptui
fi
`

const BASH = `# spinuptui shell completion for bash. Install: see \`spinuptui completion --help\`.
_spinuptui() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" out
  out="$("\${COMP_WORDS[0]}" __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null)"
  case "\${out%%$'\\n'*}" in
    :file) compopt -o filenames 2>/dev/null; COMPREPLY=($(compgen -f -- "$cur")) ;;
    :dir) compopt -o filenames 2>/dev/null; COMPREPLY=($(compgen -d -- "$cur")) ;;
    *)
      local IFS=$'\\n'
      COMPREPLY=($(compgen -W "$(printf '%s\\n' "$out" | cut -f1)" -- "$cur"))
      ;;
  esac
}
complete -F _spinuptui spinuptui
`

const FISH = `# spinuptui shell completion for fish. Install: see \`spinuptui completion --help\`.
function __spinuptui_complete
    set -l tokens (commandline -opc)
    set -l out ($tokens[1] __complete $tokens[2..-1] (commandline -ct) 2>/dev/null)
    switch "$out[1]"
        case :file
            __fish_complete_path (commandline -ct)
        case :dir
            __fish_complete_directories (commandline -ct)
        case '*'
            printf '%s\\n' $out
    end
end
complete -c spinuptui -f -a '(__spinuptui_complete)'
`

export const COMPLETION_HELP = `Usage: spinuptui completion zsh|bash|fish

Prints a script that makes Tab complete spinuptui's commands, subcommands and
flags, plus the values it can look up: site domains and server names, Scheduler
jobs and sources, Beacon channels, to-dos and Sentinel incidents.

zsh   add to ~/.zshrc, after compinit:
        source <(spinuptui completion zsh)
bash  add to ~/.bashrc:
        eval "$(spinuptui completion bash)"
fish  run once:
        spinuptui completion fish > ~/.config/fish/completions/spinuptui.fish

Homebrew installs the zsh, bash and fish scripts for you. Domains come from a
list the dashboard saves each time it loads your sites; when that list is more
than 6 hours old, the first Tab refreshes it from the API.`

export function completionScript(shell: string): string | null {
  if (shell === "zsh") return ZSH
  if (shell === "bash") return BASH
  if (shell === "fish") return FISH
  return null
}

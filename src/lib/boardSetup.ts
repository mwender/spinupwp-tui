// Guided board setup, shared by `spinuptui beacon setup basecamp` and Sentinel's
// setup overlay: find the CLI, check its login, pick a project and who to mention,
// optionally post a test, save.
//
// A failed login check is never proof of a lapsed login. The CLI keeps its login in
// the Keychain, which a sandboxed shell can't read and an SSH session may not be
// able to, so it reports "not authenticated" whatever the truth is. So a board can
// be saved unconfirmed: the morning digest runs in the real login session, and its
// Board line says what's actually true.

import { loadConfig, saveConfig, type BeaconBoard, type BeaconStored } from "../config.ts"
import { boardLogin, cliJson, postToBoard, realRun, type BasecampRun, type BoardPost } from "./beaconBoard.ts"

export const BASECAMP_CLI_URL = "https://github.com/basecamp/basecamp-cli"
export const BASECAMP_INSTALL = "curl -fsSL https://basecamp.com/install-cli | bash"

export type LoginCheck =
  | { state: "confirmed"; who: string }
  | { state: "missing"; steps: string[] }
  | { state: "unconfirmed"; steps: string[] }

// True when this process came in over SSH, where the login keychain may be out of
// reach, and where a browser-based login has nowhere to open.
export const overSsh = (env: Record<string, string | undefined> = process.env) => !!(env.SSH_CONNECTION || env.SSH_TTY)

export async function checkLogin(run: BasecampRun = realRun, ssh = overSsh()): Promise<LoginCheck> {
  const login = await boardLogin(run)
  if (login.state === "ok") return { state: "confirmed", who: login.detail }
  if (login.state === "missing") return { state: "missing", steps: [`Install the Basecamp CLI: ${BASECAMP_INSTALL}`, `(${BASECAMP_CLI_URL})`] }
  const why = ssh
    ? "This is an SSH session, which often can't read the login keychain even when the login is fine."
    : "A sandboxed shell, such as an agent's, can't read the login keychain even when the login is fine."
  return {
    state: "unconfirmed",
    steps: [
      "Couldn't confirm the Basecamp login from this session.",
      `If you've never logged in, run this in a terminal on this machine: basecamp auth login${ssh ? " --remote" : ""}`,
      why,
    ],
  }
}

export interface BoardProject {
  id: string
  name: string
}

// Projects with a message board to post to, by name.
export async function listProjects(run: BasecampRun = realRun): Promise<BoardProject[]> {
  const list = await cliJson<{ id: number; name: string; dock?: { name: string; enabled?: boolean }[] }[]>(run, ["projects", "list"])
  return (list ?? [])
    .filter((p) => p.dock?.some((d) => d.name === "message_board" && d.enabled !== false))
    .map((p) => ({ id: String(p.id), name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listPeople(run: BasecampRun = realRun): Promise<string[]> {
  const people = await cliJson<{ name: string }[]>(run, ["people", "pingable"])
  return [...new Set((people ?? []).map((p) => p.name))].sort((a, b) => a.localeCompare(b))
}

// "12345", or any URL into the project.
export function parseProjectId(input: string): string | null {
  const t = input.trim()
  if (/^\d+$/.test(t)) return t
  return /\/(?:projects|buckets)\/(\d+)/.exec(t)?.[1] ?? null
}

export const makeBoard = (projectId: string, mention?: string | null): BeaconBoard => ({ type: "basecamp", projectId, audience: "team", ...(mention ? { mention } : {}) })

// A real post, so it's always asked for first. No mention: it's a test.
export function postTest(board: BeaconBoard, run: BasecampRun = realRun): Promise<BoardPost> {
  const { mention: _none, ...quiet } = board
  return postToBoard(quiet, "# SpinupTUI is connected\n\nThis station can post to this board. You can delete this message.\n", run)
}

export async function saveBoard(name: string, board: BeaconBoard): Promise<void> {
  const stored: BeaconStored = loadConfig().beacon ?? {}
  await saveConfig({ beacon: { ...stored, boards: { ...(stored.boards ?? {}), [name]: board } } })
}

// The name for a new board, or the one being reconfigured.
export function setupBoardName(): string {
  return Object.keys(loadConfig().beacon?.boards ?? {})[0] ?? "board"
}

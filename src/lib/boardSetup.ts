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

// Who a board posts as isn't obvious: it's whichever account the CLI is logged in
// to, and that's often the person doing the setup. It works, and every report then
// looks like they wrote it.
export const ACCOUNT_INTRO = "Reports post as whichever Basecamp account the CLI is logged in to. Most teams use a separate Basecamp user for this, so reports don't look like they came from you."

// The CLI's plain login opens the default browser, usually already signed in as the
// person at the keyboard, so it can connect the wrong account before they've thought
// about it. --no-browser stops at a link they can open in a private window instead,
// and still finishes on the CLI's own listener, on a success page.
//
// Over SSH there's no Keychain, so `--remote` stores its login in a plaintext file,
// and sessions that do have the Keychain (a terminal on the Mac, the LaunchAgent
// that posts) never read that file. A login made over SSH is seen only over SSH,
// so the steps send SSH users to the Mac itself instead.
export function separateUserSteps(ssh: boolean, switching = false): string[] {
  return [
    ssh ? "To post as a separate user (most teams do), log in on the Mac itself, at its screen or over Screen Sharing. A login made over SSH is only seen over SSH, not by what posts the reports." : "To post as a separate user (most teams do):",
    `  1. ${ssh ? "In a terminal there" : "In another terminal on this machine"}, run: ${switching ? "basecamp auth logout, then " : ""}basecamp auth login --no-browser`,
    "  2. Open the link it prints in a private window (Incognito). A normal window is probably signed in as you, and would connect your own account.",
    "  3. Sign in as the separate user. When the page says you're connected, come back here.",
  ]
}

// Shown with a login confirmed over SSH: it can only be one made over SSH.
export const SSH_LOGIN_NOTE = "This login was read over SSH, which only sees a login made over SSH. The reports are posted from the Mac's own session, which doesn't see it: log in on the Mac itself too, and the morning digest's Board line will confirm it."

// Reports go to everyone in the chosen project, so it must be one only the team is in.
export const PROJECT_PROMPT = "Which project's message board? Pick one only your own team is in: everyone in the project can read the reports."

export type LoginCheck =
  | { state: "confirmed"; who: string; note?: string }
  | { state: "missing"; steps: string[] }
  | { state: "unconfirmed"; steps: string[] }

// True when this process came in over SSH, where the login keychain may be out of
// reach, and where a browser-based login has nowhere to open.
export const overSsh = (env: Record<string, string | undefined> = process.env) => !!(env.SSH_CONNECTION || env.SSH_TTY)

// Steps are lines to show as they are; "" is a blank line between groups.
export async function checkLogin(run: BasecampRun = realRun, ssh = overSsh()): Promise<LoginCheck> {
  const login = await boardLogin(run)
  if (login.state === "ok") return { state: "confirmed", who: login.detail, ...(ssh ? { note: SSH_LOGIN_NOTE } : {}) }
  if (login.state === "missing") return { state: "missing", steps: [`Install the Basecamp CLI: ${BASECAMP_INSTALL}`, `(${BASECAMP_CLI_URL})`] }
  // Still only "seems": an agent's sandboxed shell gets the same answer when the
  // login is fine. Over SSH that's common enough to say so.
  const what = ssh
    ? "Couldn't confirm the Basecamp login. An SSH session can't read the login keychain, so this proves nothing either way. After logging in on the Mac, enter the project by hand: the morning digest's Board line will confirm the login."
    : "The Basecamp CLI doesn't seem to be logged in."
  return { state: "unconfirmed", steps: [what, "", ...separateUserSteps(ssh), "", `Or post as yourself: basecamp auth login${ssh ? ", on the Mac itself" : ""}`] }
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

// Who can be mentioned on a project's posts: its own people, since anyone else
// can't see the post. Not the posting account, which would only mention itself.
export async function listPeople(projectId: string, poster: string | null = null, run: BasecampRun = realRun): Promise<string[]> {
  const people = await cliJson<{ name: string }[]>(run, ["people", "list", "--project", projectId, "--all"])
  return [...new Set((people ?? []).map((p) => p.name))].filter((n) => n !== poster).sort((a, b) => a.localeCompare(b))
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

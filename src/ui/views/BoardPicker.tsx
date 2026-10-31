// The optional board step in Sentinel's setup: the same flow as
// `spinuptui beacon setup basecamp`. A login that can't be confirmed isn't treated
// as broken: from an SSH session it often can't be, so the project can be typed in
// and the board saved anyway (lib/boardSetup.ts explains why).

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { Panel, Spinner } from "../components.tsx"
import { List, moveSelection } from "../List.tsx"
import { useStore } from "../store.tsx"
import { checkLogin, listPeople, listProjects, makeBoard, parseProjectId, postTest, saveBoard, setupBoardName, type BoardProject, type LoginCheck } from "../../lib/boardSetup.ts"

type Phase = "checking" | "blocked" | "manual" | "project" | "person" | "test" | "posting" | "failed"

const NOBODY = "Nobody"
const ROWS = 10
const WIDTH = 72

export function BoardPicker({ onDone, onCancel }: { onDone: (name: string) => void; onCancel: () => void }) {
  const { setInputMode } = useStore()
  const [phase, setPhase] = useState<Phase>("checking")
  const [login, setLogin] = useState<LoginCheck | null>(null)
  const [projects, setProjects] = useState<BoardProject[]>([])
  const [people, setPeople] = useState<string[]>([])
  const [selected, setSelected] = useState(0)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [mention, setMention] = useState<string | null>(null)
  const [typed, setTyped] = useState("")
  const [message, setMessage] = useState("")

  const check = () => {
    setPhase("checking")
    void (async () => {
      const l = await checkLogin()
      setLogin(l)
      if (l.state !== "confirmed") return setPhase("blocked")
      const [p, q] = await Promise.all([listProjects(), listPeople()])
      setProjects(p)
      setPeople([NOBODY, ...q])
      setSelected(0)
      if (!p.length) setMessage(`Logged in as ${l.who}, but no projects with a message board came back.`)
      setPhase(p.length ? "project" : "manual")
    })()
  }
  useEffect(check, [])
  useEffect(() => {
    setInputMode(phase === "manual")
    return () => setInputMode(false)
  }, [phase, setInputMode])

  const save = async (id = projectId!, who = mention) => {
    const name = setupBoardName()
    await saveBoard(name, makeBoard(id, who))
    onDone(name)
  }

  const test = () => {
    setPhase("posting")
    void postTest(makeBoard(projectId!, mention)).then((r) => {
      if (r.ok) return void save()
      setMessage(r.message)
      setPhase("failed")
    })
  }

  const items = phase === "project" ? projects.map((p) => p.name) : people

  useKeyboard((key) => {
    const name = key.name ?? ""
    if (name === "escape") return onCancel()
    if (phase === "blocked") {
      if (name === "r") return check()
      if (name === "m" && login?.state === "unconfirmed") return setPhase("manual")
      return
    }
    if (phase === "project" || phase === "person") {
      if (name === "up" || name === "k") return setSelected((i) => moveSelection(i, -1, items.length))
      if (name === "down" || name === "j") return setSelected((i) => moveSelection(i, 1, items.length))
      if (name !== "return") return
      if (phase === "project") {
        setProjectId(projects[selected]!.id)
        setSelected(0)
        return setPhase(people.length > 1 ? "person" : "test")
      }
      setMention(people[selected] === NOBODY ? null : people[selected]!)
      return setPhase("test")
    }
    if (phase === "test") {
      if (name === "t") return test()
      if (name === "s") return void save()
      return
    }
    if (phase === "failed" && name === "s") return void save()
  })

  const line = (text: string, fg: string = theme.textDim) => <text content={text} fg={fg} />
  return (
    <Panel title=" Connect a team board " active>
      <box style={{ flexDirection: "column", width: WIDTH, paddingTop: 1, paddingBottom: 1 }}>
        {phase === "checking" && (
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Checking Basecamp…" fg={theme.textDim} wrapMode="none" />
          </box>
        )}
        {phase === "blocked" && login && login.state !== "confirmed" && (
          <>
            {login.steps.map((s) => (
              <text key={s} content={s} fg={theme.text} />
            ))}
            <box style={{ height: 1 }} />
            {line(login.state === "unconfirmed" ? "r check again · m enter the project anyway · Esc cancel" : "r check again · Esc cancel", theme.accent)}
          </>
        )}
        {phase === "manual" && (
          <>
            {line("The project's ID, or any URL from the project:", theme.text)}
            <box style={{ height: 1 }} />
            <input
              focused
              value={typed}
              placeholder="https://3.basecamp.com/…/projects/123"
              onInput={setTyped}
              onSubmit={() => {
                const id = parseProjectId(typed)
                if (!id) return setMessage("That has no project ID in it.")
                void save(id, null)
              }}
              style={{ width: WIDTH - 4 }}
            />
            <box style={{ height: 1 }} />
            {message ? line(message, theme.warn) : line("The morning digest's Board line will confirm the login. Enter saves · Esc cancels")}
          </>
        )}
        {(phase === "project" || phase === "person") && (
          <>
            {line(phase === "project" ? "Which project's message board? It's for your own team: nothing here reaches a client." : "Who should be @-mentioned on a new report?", theme.text)}
            <box style={{ height: 1 }} />
            <box style={{ height: ROWS, flexDirection: "column" }}>
              <List items={items} selectedIndex={selected} viewportRows={ROWS} focused keyFor={(x) => x} renderRow={(x, sel) => <text content={x} fg={sel ? theme.text : theme.textDim} wrapMode="none" style={{ flexGrow: 1, flexShrink: 1 }} />} />
            </box>
            <box style={{ height: 1 }} />
            {line("↑↓ select · ⏎ choose · Esc cancel", theme.textFaint)}
          </>
        )}
        {phase === "test" && (
          <>
            {line("Post a test message? It's a real post, and the project's people may be notified.", theme.text)}
            <box style={{ height: 1 }} />
            {line("t post a test, then save · s save without testing · Esc cancel", theme.accent)}
          </>
        )}
        {phase === "posting" && (
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Posting…" fg={theme.textDim} wrapMode="none" />
          </box>
        )}
        {phase === "failed" && (
          <>
            {line(`✕ ${message}`, theme.bad)}
            <box style={{ height: 1 }} />
            {line("s save it anyway · Esc cancel", theme.accent)}
          </>
        )}
      </box>
    </Panel>
  )
}

// Ask for the SpinupWP account slug the first time `w` needs it.
//
// Deep links into the web app are account-scoped (spinupwp.app/{slug}/sites/{id})
// and the API doesn't expose the slug, so without one `w` could only open the
// dashboard root. Instead of that, `w` opens this prompt: the user pastes the
// slug (or any dashboard URL), it's saved to the current account, and the page
// they asked for opens. Every later `w` goes straight there.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { openUrl } from "../../lib/open.ts"
import { parseAccountSlug } from "../../lib/spinupweb.ts"
import { Panel, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { toast } from "../toast.ts"

const INPUT_STYLE = { backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }

export function AccountSlugPrompt() {
  const { slugPrompt, setSlugPrompt, saveAccountSlug, setInputMode } = useStore()
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)

  // The input owns the keyboard while this is open.
  useEffect(() => {
    setInputMode(true)
    return () => setInputMode(false)
  }, [setInputMode])

  const close = () => setSlugPrompt(null)

  const submit = () => {
    if (!slugPrompt) return
    const slug = parseAccountSlug(value)
    if (!slug) {
      setError(value.trim() ? "That doesn't look like a slug — paste the part after spinupwp.app/, or the whole URL." : "Paste your account slug, or Esc to cancel.")
      return
    }
    saveAccountSlug(slug)
    openUrl(slugPrompt.build(slug))
    toast.success(`Saved “${slug}” — opening in SpinupWP…`)
    close()
  }

  // Esc reaches us even with the input focused (it doesn't consume it).
  useKeyboard((key) => {
    if (key.name === "escape") close()
  })

  if (!slugPrompt) return null

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: theme.bg,
        zIndex: 300,
      }}
    >
      <Centered>
        <Panel title=" Open in SpinupWP " active>
          <box style={{ flexDirection: "column", width: 68, paddingTop: 1, paddingBottom: 1 }}>
            <text content="To open the right page, SpinupTUI needs your SpinupWP account slug:" fg={theme.text} wrapMode="none" />
            <text content="the part after spinupwp.app/ in your dashboard's address." fg={theme.text} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="SpinupWP's API doesn't provide it, so this asks once and saves it." fg={theme.textDim} wrapMode="none" />
            <text content="Pasting any dashboard URL works too." fg={theme.textDim} wrapMode="none" />
            <box style={{ height: 1 }} />
            <text content="Account slug" fg={theme.accent} />
            <input
              focused
              value={value}
              placeholder="acme-agency"
              onInput={(v: string) => {
                setValue(v)
                setError(null)
              }}
              onSubmit={submit}
              style={INPUT_STYLE}
            />
            <box style={{ height: 1 }} />
            {error ? <text content={"✕ " + error} fg={theme.bad} wrapMode="none" /> : <text content="Saved to this account in config.json." fg={theme.textFaint} wrapMode="none" />}
          </box>
        </Panel>
      </Centered>
      <StatusBar
        hints={[
          { key: "⏎", label: "save & open" },
          { key: "esc", label: "cancel" },
        ]}
        showGlobal={false}
      />
    </box>
  )
}

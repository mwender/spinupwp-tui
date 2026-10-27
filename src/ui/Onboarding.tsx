// First-run onboarding wizard.
//
// Shown when no token is found in the environment or config file. Collects an
// API token, validates it against the live API, persists it to ~/.config, then
// asks (optionally) for the account slug that `w` deep links need — the API
// can't tell us — and hands control back to the app.

import { useState } from "react"
import { theme } from "../lib/theme.ts"
import { Spinner, SecretInput } from "./components.tsx"
import { SpinupWPClient } from "../api/client.ts"
import { DEFAULT_BASE_URL, saveConfig, configPath } from "../config.ts"
import { parseAccountSlug } from "../lib/spinupweb.ts"

type Phase = "input" | "validating" | "error" | "slug"

const INPUT_STYLE = { backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [value, setValue] = useState("")
  const [phase, setPhase] = useState<Phase>("input")
  const [error, setError] = useState<string | null>(null)
  const [slug, setSlug] = useState("")

  async function submit(token: string) {
    const trimmed = token.trim()
    if (!trimmed) return
    setPhase("validating")
    setError(null)
    const client = new SpinupWPClient({ token: trimmed, baseUrl: DEFAULT_BASE_URL })
    const result = await client.validateToken()
    if (result.ok) {
      await saveConfig({ token: trimmed, baseUrl: DEFAULT_BASE_URL })
      setPhase("slug")
    } else {
      setError(result.reason)
      setPhase("error")
    }
  }

  // Optional: empty skips (an existing slug, e.g. on `spinuptui login`, is kept).
  async function submitSlug() {
    if (!slug.trim()) return onComplete()
    const parsed = parseAccountSlug(slug)
    if (!parsed) {
      setError("That doesn't look like a slug — paste the part after spinupwp.app/, or the whole URL.")
      return
    }
    await saveConfig({ accountSlug: parsed })
    onComplete()
  }

  if (phase === "slug") {
    return (
      <box
        style={{
          width: "100%",
          height: "100%",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.bg,
        }}
      >
        <ascii-font text="SPINUPTUI" font="block" color={[theme.brand, theme.accent]} />
        <box style={{ height: 1 }} />
        <box
          title=" Almost done "
          titleColor={theme.brand}
          border
          borderColor={theme.border}
          style={{ flexDirection: "column", width: 70, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
        >
          <text content="✓ Token works." fg={theme.good} />
          <box style={{ height: 1 }} />
          <text content="One more (optional): your SpinupWP account slug, the part" fg={theme.text} wrapMode="none" />
          <text content="after spinupwp.app/ in your dashboard's address. With it, w" fg={theme.text} wrapMode="none" />
          <text content="opens a site or server straight in SpinupWP." fg={theme.text} wrapMode="none" />
          <text content="Pasting any dashboard URL works too." fg={theme.textDim} wrapMode="none" />
          <box style={{ height: 1 }} />
          <text content="Account slug" fg={theme.accent} />
          <input
            focused
            value={slug}
            placeholder="acme-agency"
            onInput={(v: string) => {
              setSlug(v)
              setError(null)
            }}
            onSubmit={() => void submitSlug()}
            style={INPUT_STYLE}
          />
          <box style={{ height: 1 }} />
          {error ? (
            <text content={"✕ " + error} fg={theme.bad} wrapMode="none" />
          ) : (
            <text content="Press Enter to finish. Leave it empty to skip; w will ask later." fg={theme.textFaint} wrapMode="none" />
          )}
        </box>
      </box>
    )
  }

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: theme.bg,
      }}
    >
      <ascii-font text="SPINUPTUI" font="block" color={[theme.brand, theme.accent]} />
      <box style={{ height: 1 }} />
      <box
        title=" Welcome "
        titleColor={theme.brand}
        border
        borderColor={theme.border}
        style={{ flexDirection: "column", width: 70, paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
      >
        <text content="Let's connect this tool to your SpinupWP account." fg={theme.text} />
        <box style={{ height: 1 }} />
        <text content="1. In SpinupWP: Settings → API Tokens" fg={theme.textDim} />
        <text content="2. Create a token (Read Only to browse; Read/Write to upgrade PHP)" fg={theme.textDim} />
        <text content="3. Paste it below and press Enter" fg={theme.textDim} />
        <box style={{ height: 1 }} />

        <text content="API Access Token" fg={theme.accent} />
        <SecretInput
          focused={phase !== "validating"}
          value={value}
          placeholder="paste your token here…"
          onChange={setValue}
          onSubmit={() => submit(value)}
        />
        <box style={{ height: 1 }} />

        {phase === "validating" && (
          <box style={{ flexDirection: "row" }}>
            <Spinner />
            <text content="  Validating token…" fg={theme.textDim} />
          </box>
        )}
        {phase === "error" && (
          <box style={{ flexDirection: "column" }}>
            <text content={"✕ " + (error ?? "Validation failed")} fg={theme.bad} />
            <text content="Press Enter to try again." fg={theme.textFaint} />
          </box>
        )}
        {phase === "input" && (
          <text content="Your token is stored locally only, never transmitted elsewhere." fg={theme.textFaint} />
        )}
      </box>
      <box style={{ height: 1 }} />
      <text content={`Config will be saved to ${configPath()}`} fg={theme.textFaint} />
    </box>
  )
}

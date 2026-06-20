// First-run onboarding wizard.
//
// Shown when no token is found in the environment or config file. Collects an
// API token, validates it against the live API, persists it to ~/.config, then
// hands control back to the app.

import { useState } from "react"
import { theme } from "../lib/theme.ts"
import { Spinner, SecretInput } from "./components.tsx"
import { SpinupWPClient } from "../api/client.ts"
import { DEFAULT_BASE_URL, saveConfig, configPath } from "../config.ts"

type Phase = "input" | "validating" | "error"

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [value, setValue] = useState("")
  const [phase, setPhase] = useState<Phase>("input")
  const [error, setError] = useState<string | null>(null)

  async function submit(token: string) {
    const trimmed = token.trim()
    if (!trimmed) return
    setPhase("validating")
    setError(null)
    const client = new SpinupWPClient({ token: trimmed, baseUrl: DEFAULT_BASE_URL })
    const result = await client.validateToken()
    if (result.ok) {
      await saveConfig({ token: trimmed, baseUrl: DEFAULT_BASE_URL })
      onComplete()
    } else {
      setError(result.reason)
      setPhase("error")
    }
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
      <ascii-font text="SPINUP" font="block" color={[theme.brand, theme.accent]} />
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
        <text content="1. Open https://spinupwp.app/account/api/" fg={theme.textDim} />
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

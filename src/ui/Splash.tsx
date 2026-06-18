// Animated splash shown while the first batch of data loads.
// Renders a gradient ASCII logo, a tagline, and a live loading status.

import { useEffect, useState } from "react"
import { theme } from "../lib/theme.ts"
import { Spinner } from "./components.tsx"

const TAGLINE = "Terminal control center for your SpinupWP fleet"

// A subtle animated "scanline" of dots beneath the logo for some life.
function Pulse() {
  const [t, setT] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setT((v) => v + 1), 120)
    return () => clearInterval(id)
  }, [])
  const width = 24
  const pos = t % width
  let line = ""
  for (let i = 0; i < width; i++) {
    const dist = Math.abs(i - pos)
    line += dist === 0 ? "●" : dist <= 1 ? "•" : "·"
  }
  return <text content={line} fg={theme.brandDim} />
}

export function Splash({ status }: { status: string }) {
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
      <text content={TAGLINE} fg={theme.text} />
      <box style={{ height: 1 }} />
      <Pulse />
      <box style={{ height: 2 }} />
      <box style={{ flexDirection: "row" }}>
        <Spinner />
        <text content={"  " + status} fg={theme.textDim} />
      </box>
    </box>
  )
}

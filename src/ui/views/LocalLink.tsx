// Local working-copy link overlay — Phase 1 (link + view, no mutation).
//
// Opened with `L` on a selected site (Browser / Search results). Two modes:
//   • view — the site is linked: shows the validated status (Bedrock / WordPress
//     / missing) and offers open-locally actions: `t` opens a terminal at the
//     path, `v` opens the stored local URL in the browser. `e` edits, `x` unlinks.
//   • edit — a small form to enter the local path + local URL (manual entry).
//
// Per the locked spec these are LOCAL conveniences only: we open a terminal and
// the local URL — we never launch an editor and never run composer/git here.
// The mutating maintenance loop (composer update → push → deploy) is a later phase.

import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { theme } from "../../lib/theme.ts"
import { truncate } from "../../lib/format.ts"
import { Panel, Centered } from "../components.tsx"
import { StatusBar } from "../StatusBar.tsx"
import { useStore } from "../store.tsx"
import { resolveLocalLink, type LocalKind } from "../../lib/local.ts"

type Mode = "view" | "edit"
type EditField = "path" | "url"

function kindColor(kind: LocalKind, exists: boolean): string {
  if (!exists) return theme.bad
  if (kind === "bedrock") return theme.good
  if (kind === "wp") return theme.accent
  return theme.warn
}

export function LocalLinkOverlay() {
  const store = useStore()
  const { localLinkSite: site, setLocalLinkSite, localLinks, linkSite, unlinkSite, setInputMode, openLocalTerminal, openLocalUrl, linkReturnToForgotten, setLinkReturnToForgotten, setForgottenOpen } = store

  const existing = site ? localLinks.get(site.id) : undefined

  const [mode, setMode] = useState<Mode>(() => (existing ? "view" : "edit"))
  const [field, setField] = useState<EditField>("path")
  const [pathInput, setPathInput] = useState(existing?.path ?? "")
  const [urlInput, setUrlInput] = useState(existing?.localUrl ?? "")
  const [flash, setFlash] = useState<string | null>(null)

  // The form owns the keyboard while editing (suppresses global shortcuts so
  // typing a path doesn't trigger navigation). Always release on unmount.
  useEffect(() => {
    setInputMode(mode === "edit")
    return () => setInputMode(false)
  }, [mode, setInputMode])

  const close = () => {
    setInputMode(false)
    setLocalLinkSite(null)
    // If we arrived here from the "needs a local copy" report, return to it.
    if (linkReturnToForgotten) {
      setLinkReturnToForgotten(false)
      setForgottenOpen(true)
    }
  }

  const save = () => {
    const path = pathInput.trim()
    if (!site || !path) return // a path is required; the local URL is optional
    linkSite(site.id, { domain: site.domain, path, localUrl: urlInput.trim() })
    setMode("view")
  }

  const note = (msg: string) => {
    setFlash(msg)
    setTimeout(() => setFlash(null), 1800)
  }

  useKeyboard((key) => {
    const name = key.name ?? ""

    if (mode === "edit") {
      // Esc backs out: to the view mode if a link already exists, else closes.
      if (name === "escape") return existing ? setMode("view") : close()
      // ↑/↓ switch fields (Enter advances/saves via the inputs' onSubmit).
      if (name === "up") return setField("path")
      if (name === "down") return setField("url")
      return
    }

    // view mode
    switch (name) {
      case "escape":
      case "q":
        return close()
      case "t":
        if (site) note(openLocalTerminal(site.id))
        return
      case "v":
        if (site) note(openLocalUrl(site.id))
        return
      case "e":
        setPathInput(existing?.path ?? "")
        setUrlInput(existing?.localUrl ?? "")
        setField("path")
        return setMode("edit")
      case "x":
        if (site) unlinkSite(site.id)
        return close()
    }
  })

  if (!site) return null

  const state = existing ? resolveLocalLink(existing) : null

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
        zIndex: 210,
      }}
    >
      {/* Title bar */}
      <box
        style={{
          flexDirection: "row",
          height: 1,
          backgroundColor: theme.bgAlt,
          paddingLeft: 1,
          paddingRight: 1,
          alignItems: "center",
        }}
      >
        <text content="🔗 Local copy  " fg={theme.brand} style={{ flexShrink: 0 }} />
        <text content={truncate(site.domain, 40)} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
        <box style={{ flexGrow: 1 }} />
        <text content={existing ? "linked" : "not linked"} fg={existing ? theme.good : theme.textFaint} style={{ flexShrink: 0 }} />
      </box>

      <Centered>{mode === "edit" ? renderEdit() : renderView()}</Centered>

      <StatusBar hints={hints()} message={flash ?? undefined} messageColor={theme.brand} showGlobal={false} />
    </box>
  )

  function renderView() {
    return (
      <Panel title=" Linked working copy " active>
        <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
          <box style={{ flexDirection: "row" }}>
            <text content="Status  " fg={theme.textDim} style={{ flexShrink: 0 }} />
            <text
              content={state?.exists ? state.label : "missing — path not found"}
              fg={kindColor(state?.kind ?? "unknown", state?.exists ?? false)}
              wrapMode="none"
            />
          </box>
          <box style={{ flexDirection: "row" }}>
            <text content="Path    " fg={theme.textDim} style={{ flexShrink: 0 }} />
            <text content={existing?.path ?? "—"} fg={theme.text} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
          <box style={{ flexDirection: "row" }}>
            <text content="URL     " fg={theme.textDim} style={{ flexShrink: 0 }} />
            <text content={existing?.localUrl || "—"} fg={existing?.localUrl ? theme.accent : theme.textFaint} wrapMode="none" style={{ flexShrink: 1 }} />
          </box>
          <box style={{ height: 1 }} />
          <text content="t — open a terminal here    v — open the local URL" fg={theme.textDim} wrapMode="none" />
          <text content="e — edit the link           x — unlink" fg={theme.textDim} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function renderEdit() {
    return (
      <Panel title={existing ? " Edit local link " : " Link a local copy "} active>
        <box style={{ flexDirection: "column", width: 64, paddingTop: 1, paddingBottom: 1 }}>
          <text content="Local path to the working copy (~ allowed)" fg={field === "path" ? theme.accent : theme.textDim} />
          <input
            focused={field === "path"}
            value={pathInput}
            placeholder="~/code/example.com"
            onInput={setPathInput}
            onSubmit={() => setField("url")}
            style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
          />
          <box style={{ height: 1 }} />
          <text content="Local URL (optional) — Valet, Cove, LocalWP, Herd, DDEV…" fg={field === "url" ? theme.accent : theme.textDim} />
          <input
            focused={field === "url"}
            value={urlInput}
            placeholder="https://example.test"
            onInput={setUrlInput}
            onSubmit={save}
            style={{ backgroundColor: theme.bgAlt, focusedBackgroundColor: theme.bgAlt, textColor: theme.text }}
          />
          <box style={{ height: 1 }} />
          <text content="↑↓ switch field · Enter on the URL saves · Esc cancels" fg={theme.textFaint} wrapMode="none" />
        </box>
      </Panel>
    )
  }

  function hints() {
    if (mode === "edit")
      return [
        { key: "↑↓", label: "field" },
        { key: "⏎", label: "next / save" },
        { key: "esc", label: "cancel" },
      ]
    return [
      { key: "t", label: "terminal" },
      { key: "v", label: "local URL" },
      { key: "e", label: "edit" },
      { key: "x", label: "unlink" },
      { key: "esc", label: "close" },
    ]
  }
}

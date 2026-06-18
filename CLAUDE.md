# CLAUDE.md

Guidance for working in this repo. This is a Bun + OpenTUI (React reconciler)
terminal app for the SpinupWP API.

## Run / check

- `bun run dev` — run from source (needs a token; see README).
- `bun run typecheck` — `tsc --noEmit`. Keep this green.
- Must run under **Bun**, not Node — OpenTUI loads native code via Bun's FFI.

## OpenTUI gotchas learned the hard way

- **Single-line text truncation needs `wrapMode="none"`.** OpenTUI text
  word-wraps by default; in a `height: 1` row a long value (e.g.
  `web3.rockytopinsider.com`) otherwise shows only the first wrapped segment
  (`web3.`). Any growable/shrinkable text in a one-line row sets `wrapMode="none"`.
- **`flexGrow` needs a definite-width context.** A row of `flexGrow`/`flexShrink`
  children only distributes slack when its container has a real width. The
  reliable pattern (see `List.tsx`) is to wrap rows in
  `<box style={{ flexGrow: 1, flexDirection: "column" }}>` rather than setting
  `width: "100%"` on the row.
- **Borders are inside the box.** A bordered box of `height: N` has `N-2` content
  rows. Size panels/cards accordingly (the stat cards are `height: 5` for 3 lines).
- **Fixed columns set `flexShrink: 0`** so they never clip; let the one growable
  column (`flexGrow: 1, flexShrink: 1`) absorb/shed space.
- Intrinsic elements are lowercase: `box`, `text`, `input`, `select`,
  `scrollbox`, `ascii-font`, etc. `<input>` style does not accept `height`.

## Keyboard model

`useKeyboard` is global — every mounted handler receives every key. To avoid
conflicts, the store exposes `route`, `inputMode`, and `overlayOpen`; each view's
handler early-returns unless it is the active route and no input/overlay is
capturing keys (`App.tsx` handles global keys + quit).

Search has two focus states (query/actions): the search `<input>` is focused only
in query mode (`inputMode` on, suppressing global shortcuts); pressing `Tab`/`→`
blurs it and switches to "actions" focus, where the selected result's single-key
actions (`o`/`w`/`u`/`h`) fire and the Details pane becomes an action menu. `←`/`Esc`
returns to the box. (While the input is focused only `↑ ↓ Enter Esc` reliably reach
the view; `Tab`/`→` are handled because the input doesn't consume them.)

## Visual testing without a TTY

The harness has no interactive terminal. Drive the app through a PTY and
reconstruct the final frame:

```sh
( sleep 3; printf '2'; sleep 1; printf 'q' ) | script -q /dev/null bun run src/index.tsx > /tmp/out.ansi
```

OpenTUI draws incrementally with absolute cursor moves (`ESC[r;cH`) and SGR only,
so replaying the stream cumulatively onto a grid (stopping at the alt-screen exit
`ESC[?1049l`) yields the visible screen. Note OSC sequences here terminate with
ST (`ESC \`), not BEL.

## API

Mostly reads, plus one write: `upgradeSitePhp` (`PUT /sites/{id}/php`). Writes go
through `SpinupWPClient.mutate()`, which treats a `403` as "token is read-only"
(the API exposes **no** token-scope endpoint, so attempt-and-handle-403 is the
detection). Keep the read path fully working regardless of token scope. New write
actions should reuse `mutate()` + the async-event pattern (`getEvent` polling) and
the confirm-before-firing overlay (`ui/views/PhpUpgrade.tsx`).

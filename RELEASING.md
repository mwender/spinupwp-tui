# Release process

How changes get from a working tree to a published release. Following this end to
end is the default — no need to ask which files to touch; they're all listed here.

## Branching & merge policy

- **Code changes** → feature branch off `main` (`feat/…`, `fix/…`), then a **PR**,
  then **squash-merge** to `main` (delete the branch). This keeps `main` at one
  tidy commit per feature and gives each feature a durable PR artifact (the *why*,
  testing notes, decisions) — worth it now that the app makes write calls to live
  infrastructure.
- **Docs / chore only** (CHANGELOG, README, this file, version bumps) → may be
  committed **directly to `main`**; no branch/PR required.
- Never let **client domains** appear in any public artifact — commit messages,
  PR titles/bodies, release notes, code, or docs. Anonymize (e.g. "a production
  site", `web3.example.com`).
- Outward-facing, hard-to-reverse steps (pushing, merging, publishing a release)
  and anything that could touch a production site are confirmed with the user
  before running. Routine file edits are not.

## Keep the changelog current (during development)

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com). As changes
land, add bullets under `## [Unreleased]` in the right group: **Added / Changed /
Fixed / Removed** (plus **Notes** for caveats). Write user-facing impact, not
implementation detail.

## Keep the README current (part of shipping a feature)

`README.md` is user-facing docs, not just a landing page — a new feature isn't
"done" until it's there. As of the July 2026 rewrite, the README is deliberately
**short and skimmable**: a screenshot gallery, one-line Features bullets, and a
short pointer paragraph per feature area, each linking out to a full write-up in
`docs/*.md`. Don't grow the README itself back into a wall of prose — depth goes
in `docs/`, not inline. Whenever a change adds or changes user-facing behavior,
update, in the same breath:

- the **Features** list — a one-line bullet with the key and a `→ [docs/x.md](docs/x.md)`
  link (skip the link for something trivial enough to need no further detail),
- the **Keybindings** table (every new key, with where it applies),
- the relevant **docs/*.md page** — the full how-it-works detail; for a whole new
  feature area (like the DNS module or local working copies), add a new page and
  a matching short pointer section in the README (see the existing sections for
  the pattern: a sentence or two, then "Full details: `[docs/x.md](docs/x.md)`").

The **Screenshots** section isn't part of this per-feature loop — it's a Dev Mode
capture of the five main tabs (see "Dev Mode" in the README), only worth
regenerating when a change visibly reshapes one of those screens.

When cutting a release, **re-read the Features list, Keybindings table, and
docs/ pages against the new `## [Unreleased]` changelog entries** and backfill
anything that slipped — a prior release's features missing from the README is
the exact failure mode this step exists to catch.

## Versioning (SemVer, while in `0.x`)

- New user-facing feature → **minor** bump (`0.2.0` → `0.3.0`).
- Bug-fix / docs only → **patch** bump (`0.3.0` → `0.3.1`).
- The version lives in `package.json` (the app reads `pkg.version`).

## Cutting a release

Run these in order. Replace `X.Y.Z` with the new version.

1. **Land the work.** Feature branch merged to `main` (or docs committed directly).
   `bun run typecheck` is green, and `README.md` reflects the new features (see
   "Keep the README current").
2. **Bump the version** in `package.json`.
3. **Roll the changelog:** rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`,
   add a fresh empty `## [Unreleased]` above it, and update the compare links at
   the bottom:
   ```
   [Unreleased]: https://github.com/mwender/spinupwp-tui/compare/vX.Y.Z...HEAD
   [X.Y.Z]:      https://github.com/mwender/spinupwp-tui/compare/vPREV...vX.Y.Z
   ```
   (Do the version bump + changelog roll *before* tagging so the tagged commit
   carries them.)
4. **Commit** the bump + changelog (`chore: release vX.Y.Z`) and get it onto
   `main` (direct, or as part of the feature PR).
5. **Tag** an annotated tag on `main` and push it:
   ```sh
   git checkout main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z — <short theme>"
   git push origin vX.Y.Z
   ```
6. **Publish the GitHub release** matching the house style of prior releases
   (`gh release view v0.2.0` for reference):
   ```sh
   gh release create vX.Y.Z --verify-tag \
     --title "vX.Y.Z — <short theme>" \
     --notes "<intro line>

   ## Highlights
   - …

   ## Notes
   - …

   **Update:** \`bun update -g spinuptui\` (npm install) or \`git pull\` in your checkout (a linked global \`spinuptui\` picks it up immediately).

   **Full changelog:** https://github.com/mwender/spinupwp-tui/compare/vPREV...vX.Y.Z"
   ```
   - Title: `vX.Y.Z — <short theme>` (e.g. "Upgrade PHP versions (first write action)").
   - Body: short intro, `## Highlights` (bold lead-ins, key bindings in backticks),
     optional `## Fixed` / `## Notes`, the **Update** line, and the **Full
     changelog** compare link. Keep it anonymized.
7. **Publish to npm.**
   ```sh
   npm pack --dry-run   # sanity check: confirm bin/spinuptui.js and the right
                         # files are in the tarball BEFORE they ship — npm has
                         # silently stripped a malformed `bin` entry before
   npm publish
   ```
   - **Must run in a real terminal, not headless/non-interactively.** The
     account uses passkey-only 2FA — `npm publish` opens a browser-auth URL
     that npm masks/garbles without a real TTY attached, so it needs to run
     from an actual Terminal/iTerm window, not a scripted or agent shell.
   - Verify it landed: `npm view spinuptui version` should print `X.Y.Z`.

## Quick checklist

- [ ] Work merged to `main`, `bun run typecheck` green
- [ ] `README.md` Features / Keybindings / feature sections updated for new user-facing changes
- [ ] `package.json` version bumped (SemVer)
- [ ] `CHANGELOG.md`: `[Unreleased]` → `[X.Y.Z]` + date, fresh `[Unreleased]`, compare links updated
- [ ] Release commit on `main`
- [ ] `vX.Y.Z` annotated tag pushed
- [ ] GitHub release published in house style
- [ ] Published to npm (`npm publish` from a real terminal — passkey 2FA), `npm view spinuptui version` confirms it
- [ ] No client domains anywhere

# Local working copies

Bridge your SpinupWP sites to the local checkouts you actually edit. Press `L` on
a site (Servers / Stacks / Search) to link a path and the local URL where you
serve it; the site's details gain a "Local" field, and you can open the copy with
`t` (a terminal at the path) or `v` (its local URL). All of this is **local-only**
— no SpinupWP writes.

- **Auto-discover (`S`, Stacks tab).** Scan one or more folders and match their
  subdirectories to sites — by git remote, Bedrock `WP_HOME`, or folder name —
  then batch-link the matches.
- **"Needs a local copy" report (`f`, Stacks tab).** Lists the managed sites you
  have no usable local copy for (never linked, or a missing path), filterable by
  stack.
- **Markers & drift.** Linked sites show `◆` in the lists; a linked, on-disk copy
  shows its local git drift (`⇡N unpushed` / `● uncommitted`), read from the repo
  with no network.

Config keys: `localRoots` (folders to scan) and `localSites` (per-site path +
local URL — tool-agnostic: Valet, Cove, LocalWP, Herd, DDEV, …).

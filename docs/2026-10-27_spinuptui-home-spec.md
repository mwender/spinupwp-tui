# The SpinupTUI folder: just works, explains itself, shares on request

Status: built 2026-10-27 on `feat/spinuptui-home`, for the next alpha. Follows the module contract's "your work lives where you can see it" rule (`docs/2026-10-16_beacon-and-module-contract-spec.md`) and Scheduler's git sources (`docs/2026-10-20_scheduler-spec.md`).

## The question

Modules keep the user's work in `~/SpinupTUI/<module>/`. How much of that folder should SpinupTUI set up silently, and how much should it teach? Until now the answer was "create it silently, and the docs say to run `git init` yourself". That's too quiet for someone who never reads the docs, and it describes a mechanism instead of an outcome for someone who does.

## Three levels

**0. It just works, and says where things land.** The folder is created on first use with no setup step. Wherever something lands in it, the path is shown: `scheduler add` prints the job file and the reports directory, and the Modules tab's Scheduler card shows the folder and whether it's shared. Seeing the path is how users learn it.

**1. The folder explains itself.** Whichever module writes first also writes `~/SpinupTUI/README.md`. It covers what each part is, who writes it (`jobs/` is yours; `runs/` belongs to the station; `.scheduler/` is internal), what's deliberately not there (settings, tokens, locks), and how to move or share the folder. It's written only if missing and never overwritten, so it's the user's to edit. Anyone who opens the folder in Finder or an editor learns all this without reading our docs.

**2. Sharing is an opt-in action, named by its outcome.** "Share it across machines, so you can queue jobs from anywhere": `spinuptui home sync --plan|--apply`, and `f` on the Modules tab's Scheduler card. Both show a plan and run nothing until it's confirmed. Three forms:

- `--github <name>`: create a private repository with the GitHub CLI. It's offered only when `gh` is installed and signed in.
- `--remote <url>`: an empty repository the user made on any host. This keeps the feature tool-agnostic.
- `--clone <url>`: the second machine. It clones into an empty folder, and a folder holding only the starter README counts as empty.

The plan steps are: README if missing, `git init -b main`, a `.gitignore`, a first commit, the remote, a push. Run again on a shared folder, it pushes anything pending or reports nothing to do, so a failed run can simply be repeated. It holds Scheduler's tick lock while applying, so a tick can't pull or push halfway through.

## What SpinupTUI never does on its own

It never runs `git init`, creates a remote, or publishes anything without the user's confirmation. Reports and, later, Sentinel's write-ups name the user's sites and clients, so the plan always says to use a private repository.

## Guardrails (refusals, each with a remedy)

- The folder is inside iCloud Drive (including Desktop & Documents in iCloud), Dropbox, Google Drive, OneDrive or pCloud. Two syncers on one `.git` produce conflicted copies and can corrupt the index.
- The folder is inside another git repository (a project checkout). This is detected before the folder exists, too.
- A `--remote` that already has commits. Joining another machine's folder is `--clone`.
- A GitHub remote that `gh` reports as public.
- `--clone` into a folder that already holds work.

## Ownership of commits

Each module commits only its own folder. Scheduler's commits are path-limited to `runs/` and its claim file. Sentinel will commit only `sentinel/`. Nothing commits the whole tree after the first commit, so work the user has staged by hand never rides along.

## Not yet

- Linux and Windows specifics beyond the path checks. The git flow itself is portable.
- A `--all` way to move every claim from a retired station (`scheduler source claim`/`release` covers it one source at a time).

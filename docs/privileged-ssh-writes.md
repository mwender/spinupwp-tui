# Privileged writes over SSH (sudo & SSH keys)

Some things the SpinupWP API simply can't do — it has **no** surface for SSH keys or
sudo users. SpinupTUI does them directly over SSH instead, which means these actions use
**your own SSH access**, not the API token.

**Connect sudo (`S`).** Press `S` on a server and enter its SpinupWP **sudo user**
and that user's **sudo password** once. SpinupTUI validates them against the live server
(`sudo -S -p '' true`) and then holds the password **in memory for the session only**
— the username persists to config, the password is never written to plaintext config.
A connected server shows a green `● sudo` badge on its row; `S` again disconnects.

- **Remember in the macOS Keychain (opt-in).** Tick the toggle when connecting and the
  password is saved to your **login Keychain** (service `spinup-sudo`, one item per
  server) — never to `config.json`, which only keeps the username and a `keychain`
  marker. Next time you press `S` on that server, sudo **auto-unlocks** with no
  retyping (the first read may show macOS's own "allow access" prompt — choose Always
  Allow). Press `f` to forget the saved password; disconnecting (`x`) a saved server
  offers a no-password **reconnect** rather than the credential form. Off macOS the
  toggle is absent and sudo stays in-memory per session.

**Grant / revoke an SSH key (`K`).** With sudo connected, press `K` on a site to write
keys into the site user's `authorized_keys`:

- **Pick which keys** — any of **your personal keys** (discovered from `~/.ssh/*.pub`
  and your ssh-agent, so you can SSH/SFTP as yourself) and/or SpinupTUI's dedicated
  **`spinup-tui` machine key** (an ed25519 identity generated once into the config dir,
  deliberately **never added to your SpinupWP account** so SpinupWP's key reconciliation
  can't clobber it). Your selection is remembered.
- **Pick the scope** — just this site, or **every site on the server** in one pass
  (per-site progress, with a retry for any that fail).
- **Grant or remove** — `a`/`r` toggles the mode; removing pulls exactly the chosen
  key lines and leaves every other key (including SpinupWP-managed ones) untouched. The
  remote script is **idempotent** and a confirm overlay shows the exact command first.
- Site rows show what's granted at a glance — **👤** (your key) and/or **🔑** (the
  machine key).

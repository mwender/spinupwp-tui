# Server health (SSH)

The SpinupWP API exposes no live metrics, so the health view (`h` in the
Servers tab) reaches the server directly over SSH using **your local SSH keys /
agent** — the same way you'd `ssh in` and run `htop`. It runs a single batched,
**read-only** command (`cat /proc/*`, `df`, `ps`) and renders the result.

- **Connection target** is derived from the API: it connects as one of the
  server's `site_user`s at the server's IP (`site_user@ip`). No extra config
  needed if `ssh site_user@ip` already works from your terminal.
- **Non-interactive:** it uses `BatchMode=yes`, so if key auth isn't already set
  up it fails fast with a hint rather than prompting for a password.
- **Override the SSH user** (e.g. to use `root` or a sudo user) with the
  `SPINUPWP_SSH_USER` environment variable, or `"sshUser"` in the config file.
- A persistent `ControlMaster` connection keeps repeated polls fast.

Nothing is ever written to the server.

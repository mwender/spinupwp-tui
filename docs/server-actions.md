# Server actions

Press `a` on a selected server (in the **Servers** tab, or a result in **Search**)
to open the server-actions overlay: **reboot** the server, or **restart** a single
service (Nginx / PHP-FPM / MySQL / Redis). Pick → confirm → the app calls
`POST /servers/{id}/reboot` or `/services/{svc}/restart` and tracks the event to
completion — same background behavior as PHP upgrades (close the overlay and the
server's row keeps a spinner).

- **Needs a Read/Write token** (like PHP upgrades).
- **Reboot visibility.** Servers with a pending reboot show a `↻rbt` badge in the
  Servers list and on the Dashboard's "Needs attention" panel.
- **Why a reboot is pending.** The API only exposes a `reboot_required` boolean —
  no reason. So when you open the overlay on a flagged server, the app reads
  Ubuntu's `/var/run/reboot-required` + `.pkgs` over SSH (read-only, reusing the
  health view's connection) and shows the pending packages — typically a
  **kernel/security update**. This is labeled as OS-level context, not as
  SpinupWP's internal logic (a fleet-wide check confirmed the boolean tracks that
  file 1:1).
- **Reboot is the big one** — its confirmation calls out that it takes the whole
  server down briefly (every site on it); a service restart is a brief blip.
- **A toast on completion.** A reboot can take minutes; when it (or a restart)
  finishes, a non-focus-stealing toast tells you (`example.com rebooted` /
  `Nginx restarted on example.com`), so you don't have to keep checking.
- **SpinupWP platform upgrades aren't actionable here.** Servers with a pending
  SpinupWP upgrade show an `↑upg` badge, same as reboot. Unlike a reboot, the API
  only exposes this as a flag — no title, no description, no endpoint to run it.
  The overlay shows a banner and lets you press `w` to jump straight to the
  server's page in the SpinupWP web app, where the upgrade (and what it does) is
  visible and runnable.

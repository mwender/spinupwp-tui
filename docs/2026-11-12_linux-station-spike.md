# Linux station spike (2026-11-12)

A half-day spike to answer the Linux questions left open in `2026-10-15_ideas.md`, `2026-10-16_beacon-and-module-contract-spec.md` and `2026-10-20_scheduler-spec.md`, using Apple's [`container`](https://github.com/apple/container) (1.7.1) to run Linux on an Apple silicon Mac. Everything ran against the published `spinuptui@next` (1.4.0-alpha.1), installed the way a new station would install it, with no access to the Mac's home folder or config.

## Answers

| Question | Answer |
|---|---|
| Does OpenTUI's native library load on Linux? | **Yes, on both arm64 and x64.** Bun resolves `@opentui/core-linux-arm64` / `core-linux-x64`, and the TUI draws its first-run screen in a PTY. |
| Do headless commands run on Linux? | **Yes.** `--help`, `--version`, `where`, `scheduler status`, `scheduler install --plan`, `scheduler add`/`list` all work on a box with no config. |
| Does the planned systemd user timer work? | **Yes, once the unit has the env var `--plan` doesn't print** (finding 1). With linger on, the timer fires with nobody logged in, the tick takes its lock and writes `last-tick.json` as `via: dispatcher`. |
| Does `loginctl enable-linger` give a working user manager headless? | **Yes.** `systemctl --user` reaches `running` and `/run/user/<uid>/bus` exists with no login session. |
| Can libsecret hold station secrets? | **No, not usefully.** Details below. This confirms the Beacon spec's choice of `config.json` at mode 600. |

## Findings to act on

1. **`scheduler install --plan` on Linux omits `SPINUPTUI_SCHEDULER_DISPATCHER=1`.** The units `renderSystemd` writes include it (`schedulerInstall.ts`, the `env` built in `planInstall`), but the plan printout shows only `PATH:`. The Linux `--apply` refusal tells people to write the units by hand from `--plan`, and a unit written that way fails every tick with "`scheduler tick` runs due jobs on THIS machine…". Fix: print the full unit text on Linux (or every env line), or ship Linux `--apply`, which this spike shows is ready to test.
2. **Linux `--apply` is unblocked.** The exact units it would write were verified by `systemd-analyze --user verify`, `daemon-reload`, `enable --now`, a manual `start`, a scheduled firing, and a queued `script` job run end to end (see "Scheduler run" below). The remaining work is the install code path itself plus a dispatcher record in `config.json`, so `scheduler status` stops reporting "dispatcher: not installed" for a working timer (status reads that record, which only `--apply` writes).
3. **libsecret is not a station secret store.** Results, as the station user:
   - No session bus (cron/ssh-like): `secret-tool store` fails, "Object does not exist at path /org/freedesktop/secrets/collection/login".
   - Lingering user bus, gnome-keyring auto-activated: same failure; nothing ever creates or unlocks the login collection without a desktop login.
   - Unlocking by piping a password to `gnome-keyring-daemon --unlock`: store and lookup work.
   - After the daemon restarts (a reboot): lookup fails again until the password is supplied again.
   So a headless keyring only works if the station already holds the keyring password somewhere, which just moves the secret. `systemd-creds --user` would be the native alternative but doesn't exist in systemd 255 (Ubuntu 24.04); it arrived in a later release. Recommendation: keep secrets in `config.json` mode 600 on Linux, and make sudo passwords on a Linux station either unsupported or a mode-600 file with a clear warning.

## Scheduler run

A one-shot `script` job queued with `spinuptui scheduler add --kind script --when "<next minute>"` was picked up by the next timer firing, with no login session and no manual step. The report landed in `~/SpinupTUI/scheduler/runs/linux-spike-hello/2026-11-12-1245.md` with status `ok`, exit code 0, and the job's output (`hello from Linux aarch64 as station`, and the user manager reporting `running`). `last-tick.json` recorded the run with `via: dispatcher`. Its only error was the expected one on an unconfigured box: "not paged (Beacon has no channels configured)".

## Using `container` for this work

What worked well:

- **Plain containers are fast and stable.** `container run --rm --dns 1.1.1.1 docker.io/oven/bun:1 …` gives a throwaway Linux box in seconds. `--arch amd64 --rosetta` gives linux-x64 the same way.
- **systemd as PID 1 in a plain container works** and is the best "fresh station" so far: `container run -d --name sd --cap-add ALL --masked-path NONE --read-only-path NONE --dns 1.1.1.1 -v <scripts>:/spike:ro <ubuntu+systemd image> /sbin/init`, then `container exec sd …`. It boots to `running`, has logind and linger, and has no access to the Mac's home folder.

What didn't:

- **Container machines (`container machine`) wedged repeatedly in 1.7.1.** After a few execs, `machine run` stops returning (even `echo`), `machine stop` hangs, and the CLI ignores a single SIGTERM. The guest's `vminitd.log` shows `vminitd memory threshold exceeded` (about 80 MB against an 84 MB threshold) from the first 100 ms after boot, with the count climbing. Plain containers running the same image and workload never wedged. Recovery needed `launchctl remove` of every `com.apple.container.*` job and `container system start`; killing only the machine's runtime once left its disk "attachment invalid" until the whole service was reset. Worth an upstream issue with the logs; until then, prefer plain containers.
- **DNS fails if any local DNS server holds IPv4 port 53, even on loopback only.** Containers get `nameserver 192.168.64.1`, which macOS serves through mDNSResponder. When a container starts, mDNSResponder binds `*:53`, but if something already holds `127.0.0.1:53` (Laravel Valet's dnsmasq here; also WARP, Mullvad, dnscrypt-proxy, unbound) the IPv4 bind fails and only the IPv6 socket comes up. `lsof` shows mDNSResponder on `IPv6 … *:53` alone, and queries to `192.168.64.1` get "connection refused". Confirmed by stopping dnsmasq: DNS then works through `192.168.64.1` with no flags. This is [apple/container#402](https://github.com/apple/container/issues/402), open since mid-2025; the maintainers treat it as macOS behaviour. The persistent fix needs no sudo and leaves Valet alone: set default resolvers in `~/.config/container/config.toml`, then `container system stop && container system start`:

  ```toml
  [container.dns]
  nameservers = ["1.1.1.1", "8.8.8.8"]
  ```

  That covers `run`, `build` and the builder. A container machine still rewrites `/etc/resolv.conf` to the gateway on every boot.
- **Two shell traps when scripting it:** `container machine run` passes arguments oddly through `sh -c` (use a script file), and wrapping calls in `timeout` needs `-s KILL`.

## Supported Linux hardware

The floor is set by OpenTUI's native library, not by Bun or the distribution. Checked against the published `@opentui/core-linux-x64` 0.8.4 (`libopentui.so`):

- **x64 CPUs need x86-64-v3 (AVX2, BMI2, FMA).** The library uses BMI2/FMA instructions throughout its main code (900+ sites), which a compiler only emits when targeting that level. Its AVX-512 code sits behind run-time CPU checks (it ran under Rosetta, which has no AVX-512). In practice: Intel Haswell (2013) or later, AMD Excavator (2015) or Ryzen. Low-power Intel chips only gained AVX2 with Alder Lake-N (N100/N150/N200/N305, 2023), so the Celeron J4125-class (Gemini Lake) chips in many Synology and QNAP NAS boxes are below the floor.
- **arm64: any 64-bit ARM board on a 64-bit OS**, such as a Raspberry Pi 4 or 5. Verified natively in this spike.
- **glibc 2.17 or later** (2012), which any current distribution has. Bun picks its own "baseline" build on older CPUs automatically, so it doesn't raise the floor.
- **Recommended target:** a current LTS distribution (Ubuntu 24.04 tested here) with systemd, on an N100-class mini PC or better.

Unverified: headless commands never import the renderer, so the Scheduler and Beacon may run on CPUs below the floor with only the TUI unavailable. Worth one test before we promise "headless only" support on older NAS hardware.

## Not covered

- Real old Intel hardware. Rosetta emulates a modern CPU, so it won't catch a missing AVX/AVX2 instruction set; Bun ships "baseline" builds for those CPUs, and the first real NAS install should confirm the installer picks one.
- Beacon's listener, Sentinel and Samurai on Linux (they need a configured account; no token was used in this spike).
- Driving the TUI past its first-run screen on Linux.

## Reproduce

```bash
# if a local DNS server holds 127.0.0.1:53, set [container.dns] nameservers first (see above)
# image: ubuntu:24.04 + dbus dbus-user-session systemd sudo curl git unzip jq libsecret-tools gnome-keyring,
# then `systemctl set-default multi-user.target` and mask the usual container-hostile units
container build --dns 1.1.1.1 -t local/ubuntu-station:24.04 .
container run -d --name sd --dns 1.1.1.1 --memory 3G --cpus 4 \
  --cap-add ALL --masked-path NONE --read-only-path NONE local/ubuntu-station:24.04 /sbin/init
container exec sd useradd -m -u 1000 -s /bin/bash station
container exec sd loginctl enable-linger station
# as station: install bun, `bun add -g spinuptui@next`, write the units, `systemctl --user enable --now …timer`
container rm -f sd
```

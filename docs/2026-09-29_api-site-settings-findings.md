# Site-settings API: findings and roadmap

SpinupWP expanded its REST API with site-settings endpoints (announced at https://spinupwp.com/whats-new/api-manage-site-settings/, reference at https://api.spinupwp.com/, PHP SDK 1.3.0). This doc records what shipped, what it changes for SpinupTUI, and a prioritized roadmap, so the work can be picked up across sessions. Reviewed against the published docs on 2026-09-29; **nothing below has been verified live yet** unless marked.

Several earlier conclusions are now obsolete: page cache is no longer purge-only on an existing site, and backup storage/schedule is no longer out of reach (both were recorded as hard API limits while building v0.11.0 and the clone wizard).

## What's new

All writes are async and return `{ event_id }` (trackable via `GET /events/{id}`) unless noted.

| Area | Endpoints | Notes |
|---|---|---|
| Page cache | `POST` / `PUT` / `DELETE /sites/{id}/page-cache` | Params: `duration`, `duration_unit` (`s m h d w M y`), `path_exclusions`, `cookie_exclusions`, `ignored_query_params` (newline-separated). PUT: omitted fields keep their value. |
| Git | `POST` / `PUT` / `DELETE /sites/{id}/git` | Connect takes `repo`*, `branch`*, `deploy_script`, `push_to_deploy`, `deploy_key.{privatekey,publickey}`. **PUT returns a `null` event when only `deploy_script` / `push_to_deploy` change** (no server work). Here `deploy_script` sits under `/git`, unlike `POST /sites` where it's top-level. |
| Nginx | `PUT /sites/{id}/nginx` | `uploads_directory_protected`, `xmlrpc_protected`, `subdirectory_rewrite_in_place`, `public_folder`. Returns **`event_ids` (array)**, one per changed setting, empty if nothing changed. |
| WP cron | `POST` / `PUT` / `DELETE /sites/{id}/cron` | `interval` in minutes: 1, 2, 5, 10, 15, 30, 60. |
| Basic auth | `POST` / `PUT` / `DELETE /sites/{id}/basic-auth` | `username` (≥3 alpha-dash), `password` (≥3). PUT with blank password keeps the current one; returns `null` event when nothing changed. |
| Path redirects | `GET` / `POST` / `DELETE /sites/{id}/path-redirects` | `from`, `to`, `type` (`permanent` = 301, `redirect` = 302). Delete is identified by `from` + `to` in the body. Duplicate from+to is rejected. List is paginated. |
| Backups | `PUT /sites/{id}/backup-settings`, `PUT /sites/{id}/backup-schedule` | **Both return the updated Site object, not an event.** Settings: `storage_provider_id`, `_bucket`, `_region`, `_class` (aws-s3), `database` (db id or null), `paths_to_exclude`. Schedule: `daily_schedule` / `weekly_schedule` / `monthly_schedule`, each with `time_of_day` (hours 0–23, server TZ), `backup_database`, `backup_files`, `retention_period`; weekly takes `day_of_week[]`, monthly `day_of_month[{week_of_month, day_of_week}]`. Empty array disables that tier. How many slots you get depends on the SpinupWP plan. DB backup requires a database set via backup-settings first. |
| Site user | `PUT /sites/{id}/site-user` | `authentication` = `publickey` (needs `ssh_key_ids[]`) or `password` (≥8 chars). |
| Lists | `GET /ssh-keys`, `GET /storage-providers` | Team SSH keys (`id`, `name`, `fingerprint`, `publickey`); storage providers (`id`, `service`, `name`). Both paginated. |

Documented but not yet used by SpinupTUI (older endpoints): `POST /sites/{id}/disable` and `/enable` (stop serving traffic, everything kept), `POST /sites/{id}/git/deploy`, `POST /sites/{id}/file-permissions/correct`, `POST` / `DELETE /sites/{id}/spinupwp-subdomain`.

The Site object's read shape now documents `nginx.{uploads_directory_protected, xmlrpc_protected, subdirectory_rewrite_in_place}`, full `page_cache` settings, `backups.schedule.{daily,weekly,monthly}`, `basic_auth.username`, `subdomain.url`, and `disabled_at`. `src/api/types.ts` only models part of this.

### Read gaps (write-only settings)

- **Cron:** the Site object has no cron state or interval. We can set it but not read or diff it. (The clone's owner-crontab carry-over reads the crontab over SSH; SpinupWP's own `#Ansible:` lines could be parsed for the interval if needed.)
- **Site user:** no auth method and no authorized key ids in the Site object. `PUT /site-user` with `ssh_key_ids` very likely **replaces** the authorized set, and we can't read the current set first. Test on a test box before any production use.
- **Basic auth password** is never readable, so a clone can carry the username only.

## Verified live (2026-09-29, test boxes)

- **`PUT /sites/{id}/git` restores a wiped deploy script, and it sticks.** On a git-deployed clone on the test destination whose `deploy_script` read back `null`, a PUT with only `deploy_script` returned `{ "event_id": null }`, read back immediately, and was still there 3+ minutes later and after a `git/deploy`.
- **`POST /sites/{id}/git/deploy` still does not run the deploy script,** even with one configured. The event finished in 3 s with output `Git pull from origin / Checkout changes / Already on 'main'`. Caveat: there were no new commits to pull, so this doesn't rule out the script running when a pull brings changes. It is the case that matters for the clone wizard (a fresh clone has nothing new), so the wizard keeps its own SSH build.
- **Event `output` can contain raw control characters.** Parse it leniently (Python's `json` needs `strict=False`).
- Side observation for settings parity: the same clone's `page_cache` read back `cookie_exclusions: null` and `ignored_query_params: null` while its source has full lists. Create-time `page_cache.enabled` doesn't carry the source's exclusion settings.

## What this changes in SpinupTUI

1. **Clone wizard, deploy script.** SpinupWP stores the `deploy_script` sent on `POST /sites`, echoes it back, then wipes it ~90 s later (verified 2026-09-24 with three probe sites). Today the wizard detects this (`deployScriptLost`) and tells the user to re-enter it in the dashboard. Now it can re-apply it with `PUT /sites/{id}/git` after the clone settles, then re-read to confirm it stuck.
2. **Clone wizard, `git/deploy` does not build for us.** The API docs say `git/deploy` runs the script "if you have one configured", which suggested the old finding (it never runs) was really the wipe. Tested 2026-09-29 with a script configured: it still only pulls (see above). The wizard keeps running `composer install` (and a Radicle source's own script) over SSH.
3. **Clone wizard, full settings parity.** Beyond what's carried today (page cache on/off, push-to-deploy, additional domains, owner cron lines): page cache duration/exclusions, the nginx hardening toggles and multisite rewrite, basic auth (username; password prompted), path redirects, and backup settings plus schedule.
4. **Page cache toggle on existing sites.** Originally requested for v0.11.0 and shipped as purge-only (`P`) because no toggle existed.
5. **`public_folder` repair.** We detect the real webroot rather than trusting the setting (see CLAUDE.md). The setting can now be corrected to match reality via `PUT /nginx`.
6. **SSH-key handoffs.** The vanity flow and the clone's SSH-key gate deep-link to the site's `#sftp` panel. `PUT /site-user` + `GET /ssh-keys` could authorize team keys directly, subject to the replace-the-set risk above. This does not replace `K` (personal keys appended over sudo SSH).
7. **Rate limit.** Full settings parity adds roughly 6–10 writes per cloned site against the 60/min limit. The header's `API n/60` becomes load-bearing; multi-site clones may need pacing.

## Backlog this unblocks

- **Backups** (tabled 2026-07-07 because storage config lives only on SpinupWP's side): now readable and writable via the public API.
- **Security scan** (`docs/2026-06-25_security-scan-spec.md`): "PHP in uploads" and "xmlrpc exposed" become one-press API fixes instead of SSH writes; backup posture and basic auth become scan findings.
- **Bedrock maintenance loop / MCP server:** "deploy now" (`git/deploy`), branch switch, and push-to-deploy toggling are API calls.
- **Migration-parity work (PR #41):** much of its finalize/repair step can be API calls rather than SSH.

## Feature ideas

1. **Site Settings panel.** One overlay per site: cache toggle and settings, hardening toggles, cron interval, basic auth, redirects editor, git branch / push-to-deploy / deploy script. Every write uses `mutate()` plus the confirm overlay and event tracking.
2. **Fleet baseline / policy check.** A house baseline (e.g. page cache on, xmlrpc off, PHP in uploads off, daily backups with DB retained 30 days), a diff view of which sites deviate, and a canary-style "fix all" like the bulk WP core update.
3. **Fleet backups view.** Sites with no backups, no DB backup, or odd retention, plus next run time; apply a standard schedule across sites with a storage-provider picker.
4. **Private preview for clones.** Put the destination behind basic auth and enable the SpinupWP subdomain until DNS cutover, then turn both off at cutover.
5. **Redirects in the migration tools.** Show and carry path redirects alongside the DNS module.
6. **Maintenance switch.** `disable` / `enable` a site with a confirm step and a header indicator.
7. **Deploy from the app.** A "deploy now" key for git sites and a quick branch switch.

## Roadmap

In order, each step shippable on its own:

1. **Clone wizard: restore the deploy script after create**, then re-read to confirm. *Built on branch `feat/clone-restore-deploy-script`; the API behavior is verified, a full wizard run is still to do.*
2. ~~Test `git/deploy` with a configured script.~~ *Done 2026-09-29: it doesn't run the script; the wizard's SSH build stays.*
3. **Clone wizard: full settings parity** (page cache settings, nginx toggles, basic auth, redirects, backups). Update the "what carries over" docs.
4. **Page cache toggle** on existing sites (`P` gains enable/disable, or a settings panel absorbs it).
5. **Fleet baseline / policy check**, the headline candidate for the next minor release.
6. The rest of the ideas above, as prioritized at the time.

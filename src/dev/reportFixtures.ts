// Dev Mode's reports and to-do list: enough to show the Reports tab with every
// state and kind, on the fixture fleet's domains. Fixed dates, like the rest of
// the fixtures, so screenshots don't change from run to run.

import type { TodoEvent } from "../lib/todos.ts"

export interface FixtureReport {
  path: string
  text: string
  summary?: string // what an incident record would have kept
}

const report = (site: string, file: string, title: string, sections: Record<string, string>) => ({
  path: `sites/${site}/incidents/${file}`,
  text: `${title}\n\n${Object.entries(sections)
    .map(([h, body]) => `## ${h}\n\n${body}`)
    .join("\n\n")}\n`,
})

export const FIXTURE_REPORTS: FixtureReport[] = [
  {
    ...report("shop.example.com", "2026-11-10-healthz-502-scanner-burst.md", "# 11/10/2026 (14:05) - shop.example.com - healthz", {
      Symptom: "At 14:05 UTC the `healthz` monitor for shop.example.com returned 502 for three minutes. web1.example.com's PHP-FPM pool for the site was full: 20 of 20 children busy.",
      Timeline: "- 14:02: a scanner starts requesting `/wp-admin/includes/*.php` directly, about 40 a second.\n- 14:05: the pool fills and nginx returns 502.\n- 14:08: the scanner stops and the pool drains.",
      Evidence: "The access log shows 7,214 requests from one address in six minutes, all for core files that are never meant to be requested directly. Each one ran PHP and ended in a fatal.",
      "Root cause": "A vulnerability scanner, not a fault in the site. Requests for core include files reach PHP because nothing denies them.",
      Resolution: "It recovered on its own when the scan ended.",
      "Follow-ups": "- Deny direct requests to `wp-admin/includes/*.php` and `wp-config-sample.php` at nginx, so a scan costs nothing. [T-6]\n- Give the healthz monitor one retry, so a single slow minute doesn't page. [T-7]",
    }),
    summary: "shop.example.com's healthz returned 502 for three minutes while a scanner requested core include files directly, filling its PHP-FPM pool. It recovered when the scan stopped. Fix: deny those paths at nginx.",
  },
  {
    ...report("example.com", "2026-11-09-fatal-shapbot-calendar-trap.md", "# 11/09/2026 (09:41) - example.com - fatal", {
      Symptom: "The `fatal` push monitor for example.com paged at 09:41 UTC. debug.log shows a burst of fatals from the events calendar's shortcode, all under one crawler's user agent.",
      Evidence: "ShapBot requested 1,900 distinct calendar URLs in ten minutes, each a different month, back to 1970. Every one rendered the shortcode, and dates before 1990 fatal in the plugin.",
      "Root cause": "A crawler walking an unbounded calendar, and a plugin bug on old dates.",
      "Follow-ups": "- Block the ShapBot user agent at nginx. [T-4]\n- Report the pre-1990 fatal to the calendar plugin's author. [T-5]",
    }),
    summary: "example.com paged on fatals from the events calendar: ShapBot walked 1,900 calendar months back to 1970, and dates before 1990 crash the plugin. Fix: block the crawler, report the bug.",
  },
  {
    ...report("app.example.org", "2026-11-07-health-redis-maxmemory.md", "# 11/07/2026 (03:12) - app.example.org - redis", {
      Symptom: "app.example.org's Redis monitor paged at 03:12 UTC: Redis refused writes with `OOM command not allowed`.",
      "Root cause": "Redis has no `maxmemory-policy`, so once it filled it refused writes instead of evicting.",
      Resolution: "Flushed the object cache, which brought it back.",
      "Follow-ups": "- Set `maxmemory-policy allkeys-lru` on web3.example.org's Redis. [T-2]\n- Flushed the object cache (recorded, nothing to do). [T-3]",
    }),
  },
  {
    ...report("docs.example.org", "2026-11-05-health-uptime-false-alarm.md", "# 11/05/2026 (22:30) - docs.example.org - health", {
      Symptom: "The health monitor for docs.example.org paged once at 22:30 UTC and recovered a minute later. The site answered every request in the logs.",
      "Root cause": "The monitoring box lost its route for a minute; three unrelated sites paged at the same moment.",
      "Follow-ups": "- Teach Sentinel to recognise a page that hits several servers at once as the monitor's own fault. [T-1]",
    }),
  },
  report("blog.example.com", "2026-10-21-health-before-sentinel.md", "# 10/21/2026 (16:20) - blog.example.com - health", {
    Symptom: "Written by hand before Sentinel kept summaries. blog.example.com answered slowly for twenty minutes during a plugin update that rebuilt its search index.",
    "Follow-ups": "- Run search reindexes outside working hours.",
  }),
]

const at = (s: string) => `2026-11-${s}:00.000Z`
type Unversioned = TodoEvent extends infer E ? (E extends TodoEvent ? Omit<E, "v"> : never) : never
const ev = (e: Unversioned) => ({ v: 1, ...e }) as TodoEvent
const R = (n: number) => FIXTURE_REPORTS[n]!.path

export const FIXTURE_LEDGER: TodoEvent[] = [
  ev({ at: at("05T22:40"), by: "sentinel", id: "T-1", event: "created", kind: "sentinel", scope: "fleet", title: "Recognise a page that hits several servers at once as the monitor's own fault", detail: "Three unrelated sites on two servers paged in the same minute. Nothing was wrong with any of them.", report: R(3) }),
  ev({ at: at("07T03:30"), by: "sentinel", id: "T-2", event: "created", kind: "server", scope: "server:web3.example.org", title: "Set maxmemory-policy allkeys-lru on Redis", detail: "With no eviction policy, a full Redis refuses writes and the site's object cache breaks.", report: R(2) }),
  ev({ at: at("07T03:30"), by: "sentinel", id: "T-3", event: "created", kind: "note", scope: "site:app.example.org", title: "Flushed the object cache", report: R(2) }),
  ev({ at: at("09T10:02"), by: "sentinel", id: "T-4", event: "created", kind: "nginx", scope: "site:example.com", title: "Block the ShapBot user agent", detail: "It walks the events calendar month by month back to 1970.", fix: { template: "block-user-agent", params: { pattern: "ShapBot" } }, report: R(1) }),
  ev({ at: at("09T10:02"), by: "sentinel", id: "T-5", event: "created", kind: "plugin", scope: "site:example.com", title: "Report the events calendar's pre-1990 fatal to its author", detail: "Any month before 1990 crashes the shortcode.", report: R(1) }),
  ev({ at: at("10T14:20"), by: "sentinel", id: "T-6", event: "created", kind: "nginx", scope: "site:shop.example.com", title: "Deny direct requests to wp-admin/includes/*.php and wp-config-sample.php", detail: "Scanners run core files directly; each one is a fatal and a slot in the FPM pool.", fix: { template: "deny-paths", params: { paths: ["~ ^/wp-admin/includes/.*\\.php$", "= /wp-config-sample.php"], status: 403 } }, report: R(0) }),
  ev({ at: at("10T14:20"), by: "sentinel", id: "T-7", event: "created", kind: "monitoring", scope: "site:shop.example.com", title: "Give the healthz monitor one retry", detail: "A single slow minute pages today.", report: R(0) }),
  ev({ at: at("10T16:05"), by: "operator@laptop", id: "T-5", event: "wontfix", text: "The plugin is abandoned; blocking the crawler covers it." }),
  ev({ at: at("10T16:06"), by: "operator@laptop", id: "T-2", event: "done", text: "Set on web3, and in the server template." }),
  ev({ at: at("11T09:00"), by: "operator@laptop", id: "T-1", event: "snoozed", until: "2026-12-01", text: "After the monitoring box move." }),
  ev({ at: at("11T09:10"), by: "operator@laptop", id: "T-6", event: "comment", text: "Do this before the next scan." }),
]

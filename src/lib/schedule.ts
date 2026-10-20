// Scheduler's clock rules: parsing `when:` / `every:` / `expires:` and deciding
// which slot (if any) is due. A straight port of the git-backed job runner's
// rules, deliberately identical — both dispatchers read the same state.json
// during a cutover, so they must reach the same decision from it (see
// docs/2026-10-20_scheduler-spec.md, "Cutover").
//
// All times are the station's local time, written "YYYY-MM-DD HH:MM".

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

export type Schedule = { type: "interval"; minutes: number } | { type: "calendar"; days: Set<number>; hour: number; minute: number }

// Monday = 0, matching the prior art (Python's weekday()).
export function weekday(d: Date): number {
  return (d.getDay() + 6) % 7
}

const pad = (n: number) => String(n).padStart(2, "0")

export function fmt(d: Date | null | undefined): string {
  if (!d) return ""
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseWhen(value: string): Date {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/)
  const d = m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) : null
  if (!d || d.getMonth() !== +m![2]! - 1 || d.getDate() !== +m![3]! || +m![4]! > 23 || +m![5]! > 59) {
    throw new Error(`when:/created: must look like 2026-10-16 08:00 (station local time), got "${value}"`)
  }
  return d
}

// A date-only value (expires:), as that day's local midnight.
export function parseDate(value: string): Date {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const d = m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!) : null
  if (!d || d.getMonth() !== +m![2]! - 1 || d.getDate() !== +m![3]!) {
    throw new Error(`expires: must look like 2026-10-20, got "${value}"`)
  }
  return d
}

export function parseEvery(value: string): Schedule {
  const v = value.trim().toLowerCase()
  let m = v.match(/^(\d+)\s*([mh])$/)
  if (m) {
    const minutes = +m[1]! * (m[2] === "h" ? 60 : 1)
    if (minutes < 5) throw new Error("every: intervals are 5m or longer")
    return { type: "interval", minutes }
  }
  m = v.match(/^([a-z,]+)\s+(\d{1,2}):(\d{2})$/)
  if (!m) throw new Error(`every: is like '30m', '6h', 'daily 08:00', 'weekdays 08:00' or 'mon,thu 08:00', got "${value}"`)
  const hour = +m[2]!
  const minute = +m[3]!
  if (hour > 23 || minute > 59) throw new Error(`every: time out of range in "${value}"`)
  let days: Set<number>
  if (m[1] === "daily") days = new Set([0, 1, 2, 3, 4, 5, 6])
  else if (m[1] === "weekdays") days = new Set([0, 1, 2, 3, 4])
  else {
    days = new Set()
    for (const d of m[1]!.split(",")) {
      const i = (DAYS as readonly string[]).indexOf(d)
      if (i === -1) throw new Error(`every: unknown day "${d}" (use ${DAYS.join(",")})`)
      days.add(i)
    }
  }
  return { type: "calendar", days, hour, minute }
}

// A module job's `every: "10m"` / `at: "08:00"` as a Schedule.
export function declSchedule(decl: { every?: string; at?: string }): Schedule {
  if (decl.every) return parseEvery(decl.every)
  if (decl.at) return parseEvery(`daily ${decl.at}`)
  throw new Error("a scheduled job needs every: or at:")
}

export interface ScheduleState {
  last_run?: string
  last_scheduled?: string
  retry_after?: string
}

export interface DueInput {
  when?: string
  every?: string
  schedule?: Schedule
  expires?: string
  created?: string
}

function minuteOf(d: Date): Date {
  const out = new Date(d)
  out.setSeconds(0, 0)
  return out
}

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// The scheduled time this run is for, or null when nothing is due.
export function dueOccurrence(job: DueInput, state: ScheduleState, now: Date): Date | null {
  if (job.expires && dayStart(now) > parseDate(job.expires).getTime()) return null
  if (state.retry_after && now < parseWhen(state.retry_after)) return null
  const lastSched = state.last_scheduled ? parseWhen(state.last_scheduled) : null

  if (job.when) {
    const when = parseWhen(job.when)
    if (now >= when && lastSched?.getTime() !== when.getTime()) return when
    return null
  }

  const sched = job.schedule ?? parseEvery(job.every!)
  const created = job.created ? parseWhen(job.created) : null
  if (sched.type === "interval") {
    const lastRun = state.last_run ? parseWhen(state.last_run) : null
    const start = lastRun ?? created
    if (!start || now.getTime() >= start.getTime() + sched.minutes * 60_000) return minuteOf(now)
    return null
  }

  // Calendar: the latest occurrence at or before now. Missed ones collapse into
  // a single catch-up run instead of a backlog.
  for (let back = 0; back < 8; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
    const occ = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sched.hour, sched.minute)
    if (sched.days.has(weekday(day)) && occ <= now) {
      if (created && occ < created) return null
      if (!lastSched || occ > lastSched) return occ
      return null
    }
  }
  return null
}

// What `list` shows in its NEXT column.
export function nextRunText(job: DueInput, state: ScheduleState, now: Date): string {
  if (job.expires && dayStart(now) > parseDate(job.expires).getTime()) return "expired"
  if (job.when) {
    const when = parseWhen(job.when)
    return state.last_scheduled === fmt(when) ? "done" : fmt(when)
  }
  const sched = job.schedule ?? parseEvery(job.every!)
  if (sched.type === "interval") return `every ${sched.minutes} min`
  for (let ahead = 0; ahead < 8; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead)
    const occ = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sched.hour, sched.minute)
    if (sched.days.has(weekday(day)) && occ > now) return fmt(occ)
  }
  return "?"
}

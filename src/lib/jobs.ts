// Resumable-job persistence — the shared mechanism described in
// docs/2026-06-24_clone-to-server-spec.md ("Resumable jobs"). Long-running,
// fire-and-forget jobs (server create today; clone/dbSync/phpUpgrade next) mirror
// their state to config.json so a quit/relaunch can re-attach a poller via the
// stored `eventId` instead of forgetting the work.
//
// Only in-flight jobs are persisted; they're removed once terminal. Writes are
// deliberately rare (once when the job's event id is known, once on completion) —
// intermediate status is re-fetched on resume, so it needn't be stored.

import { loadConfig, saveConfig, type StoredJob } from "../config.ts"

export type { StoredJob }

// Upsert a job into the persisted set (read-modify-write; saveConfig merges).
export async function saveJob(job: StoredJob): Promise<void> {
  const jobs = { ...loadConfig().jobs, [job.id]: job }
  await saveConfig({ jobs })
}

// Remove a job from the persisted set. No-op when it isn't present.
export async function removeJob(id: string): Promise<void> {
  const jobs = { ...loadConfig().jobs }
  if (!(id in jobs)) return
  delete jobs[id]
  await saveConfig({ jobs })
}

// A persisted job is in-flight unless it has settled.
export function isJobInFlight(job: StoredJob | undefined): boolean {
  return job != null && job.status !== "done" && job.status !== "failed"
}

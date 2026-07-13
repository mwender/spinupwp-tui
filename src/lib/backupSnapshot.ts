// Local, sanitized backup handoff manifests. SpinupWP's public API exposes a
// useful backup summary but no mutation endpoints, so Clone/Finalize write this
// interoperable input for a separate dashboard-automation tool.

import { chmod, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Site } from "../api/types.ts"

export const BACKUP_SNAPSHOT_SCHEMA_VERSION = 1

type BackupSummary = NonNullable<Site["backups"]> | null

export interface BackupSnapshotSite {
  domain: string
  source_site_id: number
  destination_site_id: number | null
  backup: BackupSummary
  unavailable_fields: string[]
}

export interface BackupSnapshot {
  schema_version: typeof BACKUP_SNAPSHOT_SCHEMA_VERSION
  exported_at: string
  workflow: "clone" | "finalize"
  source_server: { id: number; name: string }
  destination_server: { id: number | null; name: string | null }
  sites: BackupSnapshotSite[]
}

// Keep handoff files out of hidden application state and logs: this is a stable,
// user-visible location that can be fed directly to a future automation tool.
export function backupSnapshotsDir(home = homedir()): string {
  return join(home, "Documents", "SpinupWP TUI", "backup-snapshots")
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "server"
}

export function backupSnapshotFilename(workflow: BackupSnapshot["workflow"], sourceName: string, destinationName: string | null, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return `${workflow}-backup-snapshot-${stamp}-${safePart(sourceName)}-to-${safePart(destinationName ?? "destination")}.json`
}

export function backupSnapshotSite(domain: string, sourceSiteId: number, destinationSiteId: number | undefined, backup: Site["backups"]): BackupSnapshotSite {
  return {
    domain,
    source_site_id: sourceSiteId,
    destination_site_id: destinationSiteId ?? null,
    // This is the literal API summary, deliberately without inferred defaults.
    backup: backup ?? null,
    // The public API does not expose these dashboard-managed settings. Stating
    // that fact makes this file safe for an automation tool to consume.
    unavailable_fields: ["schedule", "paths_to_exclude", "selected_database"],
  }
}

export async function writeBackupSnapshot(snapshot: BackupSnapshot, home?: string): Promise<string> {
  const dir = backupSnapshotsDir(home)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    await chmod(dir, 0o700)
  } catch {
    // Best effort on non-POSIX file systems.
  }
  const path = join(dir, backupSnapshotFilename(snapshot.workflow, snapshot.source_server.name, snapshot.destination_server.name))
  await Bun.write(path, JSON.stringify(snapshot, null, 2) + "\n")
  try {
    await chmod(path, 0o600)
  } catch {
    // The manifest has no credentials, but keep client infrastructure details private.
  }
  return path
}

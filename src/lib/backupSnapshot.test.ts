import { expect, test } from "bun:test"
import { backupSnapshotFilename, backupSnapshotSite, backupSnapshotsDir } from "./backupSnapshot.ts"

test("backup snapshots use a user-visible local directory", () => {
  expect(backupSnapshotsDir("/Users/alice")).toBe("/Users/alice/Documents/SpinupWP TUI/backup-snapshots")
})

test("snapshot preserves only the API backup summary and names unavailable settings", () => {
  expect(
    backupSnapshotSite("example.com", 1, undefined, {
      files: true,
      database: false,
      retention_period: 14,
      storage_provider: { id: 7, region: "nyc3", bucket: "client-backups" },
    }),
  ).toEqual({
    domain: "example.com",
    source_site_id: 1,
    destination_site_id: null,
    backup: { files: true, database: false, retention_period: 14, storage_provider: { id: 7, region: "nyc3", bucket: "client-backups" } },
    unavailable_fields: ["schedule", "paths_to_exclude", "selected_database"],
  })
})

test("snapshot filenames are filesystem-safe and have no domains", () => {
  expect(backupSnapshotFilename("clone", "ls 1", "ls/2", new Date("2026-07-13T12:34:56.000Z"))).toBe("clone-backup-snapshot-2026-07-13T12-34-56-ls_1-to-ls_2.json")
})

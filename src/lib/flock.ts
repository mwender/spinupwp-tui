// Advisory file locks via flock(2), for Scheduler's tick and per-source locks.
//
// flock rather than a pid file because it is the lock other dispatchers already
// take on a shared job source (Python's fcntl.flock is the same syscall), so a
// Scheduler tick and another runner's dispatch serialize on the same file during
// a cutover. The kernel drops the lock when the process exits, so a crashed tick
// can't leave a stale lock behind.

import { dlopen, FFIType } from "bun:ffi"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

function open() {
  const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
  return dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
}

let libc: ReturnType<typeof open> | null = null

function lib() {
  libc ??= open()
  return libc
}

export interface HeldLock {
  release(): void
}

// Takes an exclusive lock without waiting. Returns null when another process
// holds it.
export function tryLock(path: string): HeldLock | null {
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(path, "a")
  if (lib().symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd)
    return null
  }
  let held = true
  return {
    release() {
      if (!held) return
      held = false
      lib().symbols.flock(fd, LOCK_UN)
      closeSync(fd)
    },
  }
}

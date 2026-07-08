#!/usr/bin/env bun
// Published-package entry shim. The app must run under Bun — OpenTUI loads
// native code via Bun's FFI — so when a Node-based global install ignores the
// shebang, fail with instructions instead of exploding inside the renderer.
if (!process.versions?.bun) {
  console.error(
    "SpinupTUI runs on Bun (its terminal renderer uses Bun-native FFI).\n" +
      "Install Bun: https://bun.sh\n" +
      "Then reinstall with:  bun install -g spinuptui",
  )
  process.exit(1)
}
await import("../src/index.tsx")

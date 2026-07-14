import { expect, test } from "bun:test"
import { buildSwapEnsureScript, parseSwapStatus, recommendedSwapGiB, validateSwapSizeGiB } from "./swap.ts"

test("swap script is valid shell and validates the requested size", () => {
  const script = buildSwapEnsureScript(2)
  expect(Bun.spawnSync(["bash", "-n"], { stdin: new Blob([script]) }).exitCode).toBe(0)
  expect(script).toContain("swapon --noheadings --show=NAME")
  expect(script).toContain("fallocate -l 2147483648")
  expect(() => buildSwapEnsureScript(0)).toThrow()
  expect(() => buildSwapEnsureScript(1.5)).toThrow()
  expect(validateSwapSizeGiB(1)).toBe(1)
  expect(validateSwapSizeGiB(65)).toBeNull()
})

test("swap script leaves same-sized active swap untouched and protects other devices", () => {
  const script = buildSwapEnsureScript(4)
  const guard = "if [ -n \"$ACTIVE\" ] && [ \"$ACTIVE\" != /swapfile ]; then"
  expect(script).toContain(guard)
  expect(script.indexOf(guard)).toBeLessThan(script.indexOf("fallocate"))
  expect(script).toContain("CURRENT=$(stat -c %s /swapfile")
  expect(script).toContain("swapoff /swapfile")
  expect(script).toContain("if ! swapon /swapfile; then")
})

test("swap script reuses valid files and adds fstab idempotently", () => {
  const script = buildSwapEnsureScript(2)
  expect(script).toContain("TYPE=$(blkid -p -s TYPE -o value /swapfile")
  expect(script).toContain("|| printf '%s\\n' '/swapfile none swap sw 0 0' >> /etc/fstab")
  expect(script).toContain("grep -Eq '^[[:space:]]*/swapfile[[:space:]]+none[[:space:]]+swap")
  expect(script.lastIndexOf("echo ===SWAP_VERIFIED")).toBeGreaterThan(script.indexOf("swapon --noheadings --show=NAME | grep -Fxq /swapfile"))
})

test("swap status classifies active, configured-inactive, and absent swap", () => {
  const active = parseSwapStatus([
    "===SWAP",
    "/swapfile 2147483648 0 -2",
    "===MEM",
    "4294967296",
    "===FILE",
    "2147483648",
    "===FSTAB",
    "yes",
    "===END",
  ].join("\n"))
  expect(active.kind).toBe("active")
  expect(active.recommendedGiB).toBe(2)

  const inactive = parseSwapStatus("===SWAP\n===MEM\n8589934592\n===FILE\n2147483648\n===FSTAB\nno\n===END")
  expect(inactive.kind).toBe("configured-inactive")
  expect(inactive.recommendedGiB).toBe(4)

  const none = parseSwapStatus("===SWAP\n===MEM\n\n===FILE\n\n===FSTAB\nno\n===END")
  expect(none.kind).toBe("none")
  expect(recommendedSwapGiB(null)).toBe(2)
})

// Per-site PHP-FPM parity for server clones. We deliberately copy only portable
// PHP/FPM directives, never pool identity, sockets, logs, chroot, or environment.
// Values stay in memory and bypass CloneLogger because custom PHP directives can be
// sensitive in unusual installations.

import { sudoExec, type SudoCtx } from "./serverClone.ts"

export interface PhpDirective {
  key: string
  value: string
}

const PORTABLE = /^(php(?:_admin)?_(?:value|flag)\[[A-Za-z0-9_.-]+\]|pm(?:\.[A-Za-z0-9_.-]+)?|request_terminate_timeout)\s*=\s*(.+)$/

export function parsePortablePhpDirectives(text: string): PhpDirective[] {
  const values = new Map<string, string>()
  for (const line of text.split("\n")) {
    const match = line.trim().match(PORTABLE)
    if (match) values.set(match[1]!, match[2]!.trim())
  }
  return Array.from(values, ([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key))
}

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function poolPath(phpVersion: string, siteUser: string): string {
  if (!/^\d+\.\d+$/.test(phpVersion) || !/^[A-Za-z0-9_-]+$/.test(siteUser)) throw new Error("Unsupported PHP version or site user.")
  return `/etc/php/${phpVersion}/fpm/pool.d/${siteUser}.conf`
}

// Output contains only whitelisted directives and is never attached to a command log.
export async function readPortablePhpPool(ctx: SudoCtx, phpVersion: string, siteUser: string): Promise<{ ok: true; directives: PhpDirective[] } | { ok: false; error: string }> {
  let path: string
  try {
    path = poolPath(phpVersion, siteUser)
  } catch {
    return { ok: false, error: "unsupported PHP pool identity" }
  }
  const script = [
    "set -e",
    `POOL=${shq(path)}`,
    '[ -r "$POOL" ] || exit 41',
    // Keys intentionally match parsePortablePhpDirectives above.
    "grep -E '^[[:space:]]*(php(_admin)?_(value|flag)\\[[A-Za-z0-9_.-]+\\]|pm(\\.[A-Za-z0-9_.-]+)?|request_terminate_timeout)[[:space:]]*=' \"$POOL\" || true",
  ].join("\n")
  const result = await sudoExec(ctx.server, ctx.sudoUser, ctx.sudoPassword, script, 30_000)
  if (!result.ok) return { ok: false, error: "couldn't read the source PHP-FPM pool" }
  return { ok: true, directives: parsePortablePhpDirectives(result.stdout) }
}

function encode(directives: PhpDirective[]): string {
  return Buffer.from(directives.map((d) => `${d.key} = ${d.value}`).join("\n") + "\n").toString("base64")
}

export function portablePoolApplyScript(phpVersion: string, siteUser: string, directives: PhpDirective[]): string {
  const path = poolPath(phpVersion, siteUser)
  const encoded = encode(directives)
  return [
    "set -euo pipefail",
    `POOL=${shq(path)}`,
    `PHP_VERSION=${shq(phpVersion)}`,
    `DIRECTIVES=${shq(encoded)}`,
    '[ -f "$POOL" ] || exit 41',
    'BACKUP=$(mktemp); NEW=$(mktemp)',
    'cp --preserve=mode,ownership "$POOL" "$BACKUP"',
    // Strip only portable directives; all destination-specific lines remain intact.
    "awk '!/^[[:space:]]*(php(_admin)?_(value|flag)\\[[A-Za-z0-9_.-]+\\]|pm(\\.[A-Za-z0-9_.-]+)?|request_terminate_timeout)[[:space:]]*=/ { print }' \"$POOL\" > \"$NEW\"",
    'printf "\\n; SpinupTUI cloned PHP-FPM overrides\\n" >> "$NEW"',
    'printf "%s" "$DIRECTIVES" | base64 -d >> "$NEW"',
    'cat "$NEW" > "$POOL"',
    'if ! php-fpm"$PHP_VERSION" -t >/dev/null 2>&1; then cat "$BACKUP" > "$POOL"; rm -f "$BACKUP" "$NEW"; exit 65; fi',
    'if ! service "php$PHP_VERSION-fpm" reload >/dev/null 2>&1; then cat "$BACKUP" > "$POOL"; service "php$PHP_VERSION-fpm" reload >/dev/null 2>&1 || true; rm -f "$BACKUP" "$NEW"; exit 66; fi',
    'rm -f "$BACKUP" "$NEW"',
  ].join("\n")
}

export async function applyPortablePhpPool(ctx: SudoCtx, phpVersion: string, siteUser: string, directives: PhpDirective[]): Promise<{ ok: true } | { ok: false; error: string }> {
  let script: string
  try {
    script = portablePoolApplyScript(phpVersion, siteUser, directives)
  } catch {
    return { ok: false, error: "unsupported PHP pool identity" }
  }
  const result = await sudoExec(ctx.server, ctx.sudoUser, ctx.sudoPassword, script, 45_000)
  return result.ok ? { ok: true } : { ok: false, error: "destination PHP-FPM validation or reload failed" }
}

export async function syncPortablePhpPool(source: SudoCtx, dest: SudoCtx, phpVersion: string, sourceUser: string, destUser: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sourceResult = await readPortablePhpPool(source, phpVersion, sourceUser)
  if (!sourceResult.ok) return sourceResult
  const applied = await applyPortablePhpPool(dest, phpVersion, destUser, sourceResult.directives)
  if (!applied.ok) return applied
  const destinationResult = await readPortablePhpPool(dest, phpVersion, destUser)
  if (!destinationResult.ok) return { ok: false, error: "couldn't verify the destination PHP-FPM pool" }
  const actual = JSON.stringify(destinationResult.directives)
  const expected = JSON.stringify(sourceResult.directives)
  return actual === expected ? { ok: true } : { ok: false, error: "destination PHP-FPM settings did not match the source" }
}

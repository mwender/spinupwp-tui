import { expect, test } from "bun:test"
import { parsePortablePhpDirectives, portablePoolApplyScript } from "./clonePhp.ts"

test("parses portable PHP values, flags, and PHP-FPM worker controls", () => {
  const parsed = parsePortablePhpDirectives(`
user = source-user
php_admin_value[memory_limit] = 512M
php_value[max_execution_time] = 120
php_flag[display_errors] = Off
pm = dynamic
pm.max_children = 12
request_terminate_timeout = 180
`)
  expect(parsed).toEqual([
    { key: "php_admin_value[memory_limit]", value: "512M" },
    { key: "php_flag[display_errors]", value: "Off" },
    { key: "php_value[max_execution_time]", value: "120" },
    { key: "pm", value: "dynamic" },
    { key: "pm.max_children", value: "12" },
    { key: "request_terminate_timeout", value: "180" },
  ])
})

test("excludes PHP-FPM identity, socket, logs, chroot, and environment directives", () => {
  const parsed = parsePortablePhpDirectives(`
listen = /run/php/php8.3-site.sock
user = site
group = site
chdir = /sites/example/files
slowlog = /sites/example/logs/slow.log
env[SECRET] = should-not-copy
security.limit_extensions = .php
`)
  expect(parsed).toEqual([])
})

test("normalizes duplicate directives so retries are idempotent", () => {
  const parsed = parsePortablePhpDirectives("memory_limit = ignored\nphp_value[memory_limit] = 128M\nphp_value[memory_limit] = 256M\n")
  expect(parsed).toEqual([{ key: "php_value[memory_limit]", value: "256M" }])
})

test("pool update script validates and reloads only the matching PHP-FPM service", () => {
  const script = portablePoolApplyScript("8.3", "site", [{ key: "php_value[memory_limit]", value: "512M" }])
  expect(Bun.spawnSync(["bash", "-n"], { stdin: new Blob([script]) }).exitCode).toBe(0)
  expect(script).toContain('php-fpm"$PHP_VERSION" -t')
  expect(script).toContain('service "php$PHP_VERSION-fpm" reload')
})

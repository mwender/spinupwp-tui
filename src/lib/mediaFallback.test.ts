import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pluginSource } from "./mediaFallback.ts"
import { spawn } from "./spawn.ts"

// Runs the generated mu-plugin under the PHP CLI with just enough of WordPress
// stubbed to exercise its two rewrite paths: the attachment filters
// (spinup_mf_map_url) and the front-end HTML catch-all (spinup_mf_filter_html).
const hasPhp = spawn(["sh", "-c", "command -v php"], { stdout: "pipe", stderr: "pipe" }).exited.then((c) => c === 0)

const LOCAL = "https://example.test"
const PROD = "https://example.com"

async function run(localUploads: string, prodUploadsPath: string, php: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "spinup-mf-"))
  const docroot = join(dir, "docroot")
  mkdirSync(join(docroot, localUploads), { recursive: true }) // uploads dir exists, files don't
  writeFileSync(join(dir, "plugin.php"), pluginSource(PROD, prodUploadsPath))
  writeFileSync(
    join(dir, "run.php"),
    `<?php
define('ABSPATH', '/');
$_SERVER['DOCUMENT_ROOT'] = ${JSON.stringify(docroot)};
function add_filter() {}
function add_action() {}
function home_url() { return ${JSON.stringify(LOCAL)}; }
function content_url($p = '') { return ${JSON.stringify(LOCAL + localUploads.replace(/\/uploads$/, ""))} . '/' . $p; }
function wp_get_upload_dir() { return array('baseurl' => ${JSON.stringify(LOCAL + localUploads)}, 'basedir' => ${JSON.stringify(join(docroot, localUploads))}); }
require __DIR__ . '/plugin.php';
${php}
`,
  )
  const proc = spawn(["php", join(dir, "run.php")], { stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (err.trim()) throw new Error(err)
  return out
}

const mapUrl = (url: string) => `echo spinup_mf_map_url(${JSON.stringify(url)});`
const filterHtml = (html: string) => `echo spinup_mf_filter_html(${JSON.stringify(html)});`

describe.if(await hasPhp)("generated mu-plugin", () => {
  test("Standard WP → Standard WP is unchanged", async () => {
    expect(await run("/wp-content/uploads", "/wp-content/uploads", mapUrl(`${LOCAL}/wp-content/uploads/2023/06/logo.png`))).toBe(
      `${PROD}/wp-content/uploads/2023/06/logo.png`,
    )
  })
  test("Bedrock → Bedrock is unchanged", async () => {
    expect(await run("/app/uploads", "/app/uploads", mapUrl(`${LOCAL}/app/uploads/2023/06/logo.png`))).toBe(`${PROD}/app/uploads/2023/06/logo.png`)
  })
  test("no production path given behaves like v2", async () => {
    expect(await run("/app/uploads", "", mapUrl(`${LOCAL}/app/uploads/2023/06/logo.png`))).toBe(`${PROD}/app/uploads/2023/06/logo.png`)
  })
  test("Standard WP production, Bedrock local: attachment URLs use /wp-content/uploads (#100)", async () => {
    expect(await run("/app/uploads", "/wp-content/uploads", mapUrl(`${LOCAL}/app/uploads/2023/06/logo.png.webp`))).toBe(
      `${PROD}/wp-content/uploads/2023/06/logo.png.webp`,
    )
  })
  test("Bedrock production, Standard WP local: attachment URLs use /app/uploads", async () => {
    expect(await run("/wp-content/uploads", "/app/uploads", mapUrl(`${LOCAL}/wp-content/uploads/2023/06/logo.png`))).toBe(
      `${PROD}/app/uploads/2023/06/logo.png`,
    )
  })
  test("HTML catch-all maps plain and JSON-escaped URLs", async () => {
    const html = `<img src="${LOCAL}/app/uploads/2023/06/a.jpg?ver=2"><script>{"u":"https:\\/\\/example.test\\/app\\/uploads\\/2023\\/06\\/b.png"}</script>`
    expect(await run("/app/uploads", "/wp-content/uploads", filterHtml(html))).toBe(
      `<img src="${PROD}/wp-content/uploads/2023/06/a.jpg?ver=2"><script>{"u":"https:\\/\\/example.com\\/wp-content\\/uploads\\/2023\\/06\\/b.png"}</script>`,
    )
  })
  test("HTML catch-all leaves paths outside the local uploads root alone", async () => {
    const html = `<img src="${LOCAL}/wp-content/uploads/2019/01/legacy.jpg"><img src="${LOCAL}/app/themes/t/logo.svg">`
    expect(await run("/app/uploads", "/wp-content/uploads", filterHtml(html))).toBe(
      `<img src="${PROD}/wp-content/uploads/2019/01/legacy.jpg"><img src="${PROD}/app/themes/t/logo.svg">`,
    )
  })
  test("a file present locally is left alone", async () => {
    const out = await run(
      "/app/uploads",
      "/wp-content/uploads",
      `@mkdir($_SERVER['DOCUMENT_ROOT'] . '/app/uploads/2023/06', 0777, true); touch($_SERVER['DOCUMENT_ROOT'] . '/app/uploads/2023/06/here.jpg');` +
        filterHtml(`<img src="${LOCAL}/app/uploads/2023/06/here.jpg">`),
    )
    expect(out).toBe(`<img src="${LOCAL}/app/uploads/2023/06/here.jpg">`)
  })
})

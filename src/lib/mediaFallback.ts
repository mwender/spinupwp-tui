// Production media fallback for a linked local site.
//
// After a `p` prod→local DB sync the local DB is current but media files aren't
// pulled down, so browsing locally shows broken images. This drops a small,
// self-contained mu-plugin into the LOCAL WordPress copy that rewrites any
// uploads URL whose file is MISSING locally to the production origin — so images
// resolve without syncing the (often huge) media library.
//
// The feature is LOCAL-ONLY and read-only on production (it just hotlinks the
// site's own production images). Its on/off state is the file's presence — no
// config flag — so enabling/disabling is just writing/removing the plugin. The
// plugin self-configures from `wp_get_upload_dir()` (correct for Standard WP,
// Bedrock, and multisite) and self-disables when running on the production
// domain, so it's inert if ever deployed.

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { Site } from "../api/types.ts"
import { expandPath, findProjectRoot, type LocalLink } from "./local.ts"

const PLUGIN_FILE = "spinup-media-fallback.php"
// Identifies a plugin WE generated, so we never touch a user's own file.
const MARKER = "spinup:media-fallback"
// Bumped whenever the generated PHP changes; an installed file older than this
// surfaces an "update available" prompt in the overlay. A file carrying our
// marker but no version tag predates versioning and counts as v1.
const PLUGIN_VERSION = 2

export interface MediaFallbackPlan {
  localRoot: string // where the local WordPress install lives
  muDir: string // the mu-plugins dir (created on enable)
  pluginPath: string // muDir/spinup-media-fallback.php
  prodOrigin: string // https://prod-domain — the fallback source
  stack: "bedrock" | "standard"
  enabled: boolean // our plugin currently present
  version: number // the version this build would write
  installedVersion: number | null // version on disk, or null when not installed
  updateAvailable: boolean // installed but older than `version`
}

export type MediaFallbackResult = { ok: true; plan: MediaFallbackPlan } | { ok: false; error: string }

// Bedrock keeps wp-content under web/app; Standard WP under wp-content. Detect by
// the on-disk content dir so the plugin lands where WordPress autoloads mu-plugins.
function contentMuDir(localRoot: string): { dir: string; stack: "bedrock" | "standard" } {
  if (existsSync(join(localRoot, "web", "app"))) return { dir: join(localRoot, "web", "app", "mu-plugins"), stack: "bedrock" }
  return { dir: join(localRoot, "wp-content", "mu-plugins"), stack: "standard" }
}

// True only when the file exists AND carries our marker (never report or remove a
// user's own same-named plugin).
function isOurs(pluginPath: string): boolean {
  return installedVersion(pluginPath) !== null
}

// Version of an installed plugin: the tagged number, 1 for a marked-but-untagged
// file (predates versioning), or null when the file is absent / not ours.
function installedVersion(pluginPath: string): number | null {
  try {
    const txt = readFileSync(pluginPath, "utf8")
    if (!txt.includes(MARKER)) return null
    const m = txt.match(/spinup:media-fallback v(\d+)/)
    return m ? parseInt(m[1], 10) : 1
  } catch {
    return null
  }
}

export function planMediaFallback(site: Site, link: LocalLink | undefined): MediaFallbackResult {
  if (!link) return { ok: false, error: "Not linked — press L to link a local copy first." }
  const dir = expandPath(link.path)
  if (!existsSync(dir)) return { ok: false, error: "Local path is missing — press L to fix the link." }

  const localRoot = findProjectRoot(dir)
  const { dir: muDir, stack } = contentMuDir(localRoot)
  const pluginPath = join(muDir, PLUGIN_FILE)
  const prodOrigin = `${site.https?.enabled ? "https" : "http"}://${site.domain}`
  const iv = installedVersion(pluginPath)
  return {
    ok: true,
    plan: {
      localRoot,
      muDir,
      pluginPath,
      prodOrigin,
      stack,
      enabled: iv !== null,
      version: PLUGIN_VERSION,
      installedVersion: iv,
      updateAvailable: iv !== null && iv < PLUGIN_VERSION,
    },
  }
}

// Write (or refresh) the mu-plugin. Idempotent; safe to call repeatedly.
export function enableMediaFallback(plan: MediaFallbackPlan): void {
  mkdirSync(plan.muDir, { recursive: true })
  writeFileSync(plan.pluginPath, pluginSource(plan.prodOrigin))
}

// Remove the mu-plugin — but only if it's the one we generated.
export function disableMediaFallback(plan: MediaFallbackPlan): void {
  if (isOurs(plan.pluginPath)) unlinkSync(plan.pluginPath)
}

// The generated mu-plugin. String.raw keeps PHP backslashes (regex) intact; the
// only interpolation is the production origin. The marker comment must survive.
function pluginSource(origin: string): string {
  return String.raw`<?php
/**
 * Plugin Name: Spinup Media Fallback (local dev)
 * Description: Serve missing local uploads from production so images resolve without syncing the whole media library. Managed by spinup — safe to delete.
 *
 * ${MARKER} v${PLUGIN_VERSION}
 *
 * Generated by the spinup TUI for local development. When an uploaded file is
 * not present locally, its URL is rewritten to the production origin below.
 * Self-disables when the site runs on its production domain, so it is inert if
 * ever deployed. Define SPINUP_MEDIA_FALLBACK_DISABLE truthy to force it off.
 */

if (!defined('ABSPATH')) {
    return;
}

if (!defined('SPINUP_MEDIA_FALLBACK_ORIGIN')) {
    define('SPINUP_MEDIA_FALLBACK_ORIGIN', '${origin}');
}

/**
 * Active only on a non-production host (computed once, lazily — after options are
 * loaded). Prevents borrowing from ourselves and makes an accidental deploy inert.
 */
function spinup_mf_active() {
    static $active = null;
    if ($active !== null) {
        return $active;
    }
    $active = false;
    if (defined('SPINUP_MEDIA_FALLBACK_DISABLE') && SPINUP_MEDIA_FALLBACK_DISABLE) {
        return $active;
    }
    $origin = SPINUP_MEDIA_FALLBACK_ORIGIN;
    $prod_host = $origin ? parse_url($origin, PHP_URL_HOST) : '';
    $home_host = parse_url(home_url(), PHP_URL_HOST);
    if (!$prod_host || !$home_host) {
        return $active;
    }
    $suffix = '.' . $prod_host;
    // On the production domain (or a clone using it)? Then do nothing.
    if ($home_host === $prod_host || substr($home_host, -strlen($suffix)) === $suffix) {
        return $active;
    }
    $active = true;
    return $active;
}

/**
 * [local base URL, local base dir, production base URL] for uploads. Cached.
 */
function spinup_mf_base() {
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    $u = wp_get_upload_dir();
    $base_url = rtrim($u['baseurl'], '/');
    $base_dir = rtrim($u['basedir'], '/');
    $path = parse_url($base_url, PHP_URL_PATH);
    $prod_base = rtrim(SPINUP_MEDIA_FALLBACK_ORIGIN, '/') . $path;
    $cache = array($base_url, $base_dir, $prod_base);
    return $cache;
}

/**
 * Is the uploads-relative file (e.g. /2024/05/x-300x200.jpg) present locally?
 */
function spinup_mf_local_has($rel) {
    $base = spinup_mf_base();
    $rel_path = strtok($rel, '?'); // drop any ?ver= cache buster
    return @file_exists($base[1] . $rel_path);
}

/**
 * Rewrite a full local uploads URL to production when the file is missing.
 */
function spinup_mf_map_url($url) {
    if (!is_string($url) || $url === '' || !spinup_mf_active()) {
        return $url;
    }
    $base = spinup_mf_base();
    if (strpos($url, $base[0]) !== 0) {
        return $url;
    }
    $rel = substr($url, strlen($base[0]));
    if (spinup_mf_local_has($rel)) {
        return $url;
    }
    return $base[2] . $rel;
}

// Core-generated URLs (blocks, themes, and the admin media library).
add_filter('wp_get_attachment_url', 'spinup_mf_map_url', 99);
add_filter('wp_get_attachment_image_src', function ($image) {
    if (is_array($image) && isset($image[0])) {
        $image[0] = spinup_mf_map_url($image[0]);
    }
    return $image;
}, 99);
add_filter('wp_calculate_image_srcset', function ($sources) {
    if (is_array($sources)) {
        foreach ($sources as $k => $s) {
            if (isset($s['url'])) {
                $sources[$k]['url'] = spinup_mf_map_url($s['url']);
            }
        }
    }
    return $sources;
}, 99);

/**
 * Would a local-origin request for $path 404? Decide from the real document root
 * (what the web server itself would resolve), so this works for ANY path — the
 * current uploads dir, a legacy /wp-content/uploads after a Bedrock conversion,
 * or a CDN-offloaded path. Returns the production URL to use, or null to keep the
 * local one. Deferring to production by path means production's own routing
 * (redirects, S3/CDN) resolves whatever we hand it.
 */
function spinup_mf_map_path($path) {
    $root = isset($_SERVER['DOCUMENT_ROOT']) ? rtrim($_SERVER['DOCUMENT_ROOT'], '/') : '';
    if ($root !== '' && @file_exists($root . $path)) {
        return null; // present locally — leave it
    }
    return rtrim(SPINUP_MEDIA_FALLBACK_ORIGIN, '/') . $path;
}

// Front-end catch-all: rewrite any local-origin media URL in the final HTML whose
// file is missing locally — covers hardcoded URLs and page builders (e.g.
// Elementor inline background-image CSS) that bypass the attachment filters, plus
// JSON-escaped URLs (\/) that Elementor embeds for galleries/lightboxes.
add_action('template_redirect', function () {
    if (!spinup_mf_active()) {
        return;
    }
    if (is_admin() || is_feed()
        || (defined('DOING_AJAX') && DOING_AJAX)
        || (defined('REST_REQUEST') && REST_REQUEST)
        || (defined('WP_CLI') && WP_CLI)) {
        return;
    }
    ob_start('spinup_mf_filter_html');
});

function spinup_mf_filter_html($html) {
    if (!is_string($html) || $html === '' || !spinup_mf_active()) {
        return $html;
    }
    $home_host = parse_url(home_url(), PHP_URL_HOST);
    if (!$home_host) {
        return $html;
    }
    $host = preg_quote($home_host, '#');
    // Media-ish extensions worth a production fallback (not js/css — those are
    // local code, and the file-exists check would leave them alone anyway).
    $ext = 'jpe?g|png|gif|webp|avif|svg|bmp|ico|tiff?|heic|pdf|mp4|m4v|mov|webm|ogv|mp3|wav|ogg|m4a|woff2?|ttf|otf|eot';
    // A slash that may be JSON-escaped (\/), so one pass matches plain, protocol-
    // relative, and escaped URLs alike.
    $sl = '(?:\\\\?/)';
    $seg = '[^\s"\'()<>\\\\/]';
    $re = '#(?:https?:)?' . $sl . $sl . $host . '(?:' . $sl . $seg . '+)+\.(?:' . $ext . ')(?:\?' . $seg . '*)?#i';
    return preg_replace_callback($re, function ($m) use ($host) {
        $url = $m[0];
        $escaped = strpos($url, '\\/') !== false;
        $norm = $escaped ? str_replace('\\/', '/', $url) : $url;
        $rest = preg_replace('#^(?:https?:)?//' . $host . '#i', '', $norm); // /path(?query)
        $qpos = strpos($rest, '?');
        $path = $qpos === false ? $rest : substr($rest, 0, $qpos);
        $query = $qpos === false ? '' : substr($rest, $qpos);
        $prod = spinup_mf_map_path($path);
        if ($prod === null) {
            return $m[0];
        }
        $out = $prod . $query;
        return $escaped ? str_replace('/', '\\/', $out) : $out;
    }, $html);
}
`
}

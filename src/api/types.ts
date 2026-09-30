// Type definitions for the SpinupWP REST API (v1).
// Kept intentionally permissive — the API may add fields over time, and we only
// depend on the subset we render. See https://api.spinupwp.com/ for the full spec.

export interface Pagination {
  previous: string | null
  next: string | null
  per_page: number
  count: number
}

export interface ApiList<T> {
  data: T[]
  pagination: Pagination
}

export interface ApiSingle<T> {
  data: T
}

export interface DiskSpace {
  total: number
  available: number
  used: number
  updated_at: string | null
}

export interface ServerDatabase {
  server: string | null
  host: string | null
  port: number | null
}

export type ConnectionStatus = "connected" | "disconnected" | "connecting" | string

export interface Server {
  id: number
  name: string
  provider_name: string | null
  ubuntu_version: string | null
  ip_address: string | null
  ssh_port: number | null
  timezone: string | null
  region: string | null
  size: string | null
  disk_space: DiskSpace | null
  database: ServerDatabase | null
  ssh_publickey?: string | null
  git_publickey?: string | null
  connection_status: ConnectionStatus
  reboot_required: boolean
  upgrade_required: boolean
  install_notes?: string | null
  created_at: string
  status: string
}

export interface AdditionalDomain {
  id: number
  domain: string
  redirect?: {
    enabled: boolean
    type: number
    destination: string
  }
  created_at: string
}

// Page cache as the Site object reports it. The exclusion lists come back as ONE
// pipe-joined regex ("/wp-admin/|/wp-json/|…") but are WRITTEN newline-separated —
// see splitCacheList in lib/cloneSettings.ts. Unset lists read back null.
export interface PageCacheSettings {
  enabled: boolean
  duration?: number | null
  duration_unit?: string | null
  path_exclusions?: string | null
  cookie_exclusions?: string | null
  ignored_query_params?: string | null
}

export interface NginxSettings {
  uploads_directory_protected?: boolean
  xmlrpc_protected?: boolean
  subdirectory_rewrite_in_place?: boolean
}

export interface Site {
  id: number
  server_id: number
  domain: string
  additional_domains?: AdditionalDomain[]
  site_user: string | null
  php_version: string | null
  public_folder: string | null
  is_wordpress: boolean
  page_cache?: PageCacheSettings
  https?: { enabled: boolean }
  nginx?: NginxSettings
  database?: {
    id: number | null
    user_id: number | null
    table_prefix: string | null
  } | null
  backups?: {
    files: boolean
    database: boolean
    retention_period?: number | null
    next_run_time?: string | null
    storage_provider?: { id: number; region: string; bucket: string } | null
  } | null
  wp_core_update?: boolean
  wp_theme_updates?: number
  wp_plugin_updates?: number
  git?: {
    repo: string | null
    branch: string | null
    deploy_script?: string | null
    push_enabled?: boolean
    deployment_url?: string | null
  } | null
  basic_auth?: { enabled: boolean; username?: string | null } | null
  subdomain?: { enabled: boolean; url: string | null } | null
  created_at: string
  status: string
}

// Server-provider metadata (GET /providers/{provider}/metadata) — the catalog of
// sizes and regions a provider offers, including pricing. Used to show "match
// source" specs + a monthly cost before creating a server.
export interface ProviderSize {
  slug: string
  type?: string
  memory: number // MB
  vcpus: number
  disk: number // GB
  transfer?: number
  priceMonthly: number
  backupPriceMonthly?: number
  available?: boolean
  processor?: string
}

export interface ProviderRegion {
  slug: string
  name: string
  available?: boolean
  continent?: string
  sizes: string[] // size slugs offered in this region
}

export interface ProviderMetadata {
  regions: Record<string, ProviderRegion[]> // grouped by continent name
  sizes: ProviderSize[]
}

// Request body for POST /servers (provision a managed server). The API uses
// bracketed form keys (server_provider[id], …) which map to these nested objects.
export interface CreateServerPayload {
  server_provider: {
    id?: number // an existing provider connection (from SpinupWP Account Settings)
    name?: string // or provider name + token to use an unsaved provider
    api_token?: string
    region: string
    size: string
    enable_backups?: boolean
  }
  hostname: string
  timezone?: string
  database?: { root_password?: string }
  database_provider?: { id: number }
  post_provision_script?: string
}

// POST /sites. HTTPS is NOT a creation field — it's enabled afterward via
// POST /sites/{id}/https (see SpinupWPClient.enableHttps). For a vanity/placeholder
// site we use installation_method "blank" (empty docroot we drop an index.php into).
// POST /sites/{id}/domains — add an additional domain (async, returns event_id).
// redirect.type: 301/302/307/308 (defaults 301); redirect.destination defaults to
// the site's primary domain.
export interface AddDomainPayload {
  domain: string
  redirect?: { enabled?: boolean; type?: number; destination?: string }
}

export interface CreateSitePayload {
  server_id: number
  domain: string
  site_user: string
  installation_method: "wp" | "wp_subdirectory" | "wp_subdomain" | "git" | "blank"
  php_version?: string // defaults to 8.3 server-side
  public_folder?: string // defaults to "/"
  database?: { name?: string; username?: string; password?: string; table_prefix?: string }
  page_cache?: { enabled?: boolean }
  // installation_method "git" (Bedrock): SpinupWP clones `git.repo` at create time.
  // We always send a UNIQUE per-site keypair via `deploy_key_enabled` + `deploy_key`
  // (SpinupWP installs it as the site's git identity) — the server-wide git_publickey
  // can only be attached to ONE GitHub repo account-wide, so it can never cover a
  // second repo on the same server (verified 2026-07-06). The public half must be a
  // read-only deploy key on the repo before create or the clone fails. `deploy_script`
  // is TOP-LEVEL (a nested git.deploy_script is silently ignored); the write key is
  // `push_to_deploy` (the read shape echoes it back as git.push_enabled). See the
  // site-creation findings doc.
  deploy_script?: string
  git?: {
    repo: string
    branch?: string
    push_to_deploy?: boolean
    always_run_deploy_script?: boolean
    deploy_key_enabled?: boolean
    deploy_key?: { privatekey: string; publickey: string }
  }
}

// PUT /sites/{id}/git — at least one field. Unlike POST /sites, deploy_script sits
// alongside the git settings here, and the write key is push_to_deploy.
export interface UpdateSiteGitPayload {
  repo?: string
  branch?: string
  deploy_script?: string
  push_to_deploy?: boolean
}

// POST/PUT /sites/{id}/page-cache. Lists are newline-separated on write. PUT keeps
// any omitted field.
export interface PageCachePayload {
  duration?: number
  duration_unit?: string
  path_exclusions?: string
  cookie_exclusions?: string
  ignored_query_params?: string
}

// A site's path redirect (GET /sites/{id}/path-redirects). type: "permanent" = 301,
// "redirect" = 302. Delete is keyed by from + to — there's no id.
export interface PathRedirect {
  from: string
  to: string
  type: "permanent" | "redirect"
  created_at?: string
}

// The server-level WP cron intervals SpinupWP accepts, in minutes.
export const WP_CRON_INTERVALS = [1, 2, 5, 10, 15, 30, 60] as const

export interface Event {
  id: number
  initiated_by: string | null
  server_id: number | null
  name: string
  status: string
  output: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

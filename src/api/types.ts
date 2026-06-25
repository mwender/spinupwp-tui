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

export interface Site {
  id: number
  server_id: number
  domain: string
  additional_domains?: AdditionalDomain[]
  site_user: string | null
  php_version: string | null
  public_folder: string | null
  is_wordpress: boolean
  page_cache?: { enabled: boolean }
  https?: { enabled: boolean }
  nginx?: Record<string, unknown>
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
export interface CreateSitePayload {
  server_id: number
  domain: string
  site_user: string
  installation_method: "wp" | "wp_subdirectory" | "wp_subdomain" | "git" | "blank"
  php_version?: string // defaults to 8.3 server-side
  public_folder?: string // defaults to "/"
  database?: { name?: string; username?: string; password?: string; table_prefix?: string }
  page_cache?: { enabled?: boolean }
}

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

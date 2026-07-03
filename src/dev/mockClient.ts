// In-memory stand-in for SpinupWPClient, used when SPINUP_DEV_MODE is on (see
// devMode.ts). Backed by the fixture fleet in fixtures.ts; writes mutate this
// module's own copy of the data and never touch the network. Event polling
// simulates a couple of "running" ticks before settling "deployed" so the same
// spinners/toasts a real write shows are visible in a demo.
//
// Every write here always succeeds — Dev Mode is for showing the UI's happy path,
// not for testing SpinupWP's error handling (the real client covers that).

import type {
  CreateServerPayload,
  CreateSitePayload,
  Event,
  ProviderMetadata,
  Server,
  Site,
} from "../api/types.ts"
import type { ServerService, SpinupWPClientLike } from "../api/client.ts"
import { freshFixtures } from "./fixtures.ts"

const EVENT_POLLS_BEFORE_DONE = 2 // ~2 poll intervals of visible "in progress" state

function nextIdAfter(items: { id: number }[], floor: number): number {
  return Math.max(floor, ...items.map((i) => i.id)) + 1
}

function fakeProviderMetadata(): ProviderMetadata {
  return {
    regions: {
      "North America": [
        { slug: "nyc3", name: "New York 3", available: true, continent: "North America", sizes: ["s-1vcpu-2gb", "s-2vcpu-4gb"] },
      ],
    },
    sizes: [
      { slug: "s-1vcpu-2gb", type: "standard", memory: 2048, vcpus: 1, disk: 50, priceMonthly: 12, available: true },
      { slug: "s-2vcpu-4gb", type: "standard", memory: 4096, vcpus: 2, disk: 80, priceMonthly: 24, available: true },
    ],
  }
}

export function createMockClient(): SpinupWPClientLike {
  const { servers, sites, events } = freshFixtures()
  let nextServerId = nextIdAfter(servers, 200)
  let nextSiteId = nextIdAfter(sites, 2000)
  let nextEventId = nextIdAfter(events, 9100)
  const eventPolls = new Map<number, number>()

  function pushEvent(name: string, serverId: number | null, output: string): number {
    const id = nextEventId++
    const now = new Date().toISOString()
    events.unshift({ id, initiated_by: "dev-mode", server_id: serverId, name, status: "running", output, created_at: now, started_at: now, finished_at: null })
    return id
  }

  return {
    async validateToken() {
      return { ok: true }
    },

    async listServers() {
      return servers.map((s) => ({ ...s }))
    },

    async getServer(id) {
      const found = servers.find((s) => s.id === id)
      if (!found) throw new Error(`dev mode: no such server ${id}`)
      return { ...found }
    },

    async providerMetadata() {
      return fakeProviderMetadata()
    },

    async createServer(payload: CreateServerPayload) {
      const id = nextServerId++
      const server: Server = {
        id,
        name: payload.hostname,
        provider_name: payload.server_provider.name ?? "digitalocean",
        ubuntu_version: "24.04",
        ip_address: `203.0.113.${(id % 200) + 20}`,
        ssh_port: 22,
        timezone: payload.timezone ?? "UTC",
        region: payload.server_provider.region,
        size: payload.server_provider.size,
        disk_space: { total: 80 * 1024 * 1024 * 1024, available: 78 * 1024 * 1024 * 1024, used: 2 * 1024 * 1024 * 1024, updated_at: new Date().toISOString() },
        database: null,
        connection_status: "connected",
        reboot_required: false,
        upgrade_required: false,
        created_at: new Date().toISOString(),
        status: "active",
      }
      servers.push(server)
      const event_id = pushEvent("server.provisioned", id, `Server ${payload.hostname} provisioned`)
      return { event_id }
    },

    async listSites(serverId) {
      const rows = serverId ? sites.filter((s) => s.server_id === serverId) : sites
      return rows.map((s) => ({ ...s }))
    },

    async getSite(id) {
      const found = sites.find((s) => s.id === id)
      if (!found) throw new Error(`dev mode: no such site ${id}`)
      return { ...found }
    },

    async createSite(payload: CreateSitePayload) {
      const id = nextSiteId++
      const site: Site = {
        id,
        server_id: payload.server_id,
        domain: payload.domain,
        site_user: payload.site_user,
        php_version: payload.php_version ?? "8.3",
        public_folder: payload.public_folder ?? "/",
        is_wordpress: payload.installation_method !== "blank",
        page_cache: { enabled: payload.page_cache?.enabled ?? false },
        https: { enabled: false },
        database: payload.database ? { id, user_id: id, table_prefix: payload.database.table_prefix ?? "wp_" } : null,
        git: payload.git ? { repo: payload.git.repo, branch: payload.git.branch ?? "main", deploy_script: payload.deploy_script ?? null, push_enabled: payload.git.push_to_deploy ?? false, deployment_url: null } : null,
        wp_core_update: false,
        wp_theme_updates: 0,
        wp_plugin_updates: 0,
        created_at: new Date().toISOString(),
        status: "active",
      }
      sites.push(site)
      const event_id = pushEvent("site.created", payload.server_id, `Site ${payload.domain} created`)
      return { event_id }
    },

    async enableHttps(siteId) {
      const site = sites.find((s) => s.id === siteId)
      if (site) site.https = { enabled: true }
      const event_id = pushEvent("site.https.enabled", site?.server_id ?? null, `HTTPS enabled for ${site?.domain ?? siteId}`)
      return { event_id }
    },

    async disableHttps(siteId) {
      const site = sites.find((s) => s.id === siteId)
      if (site) site.https = { enabled: false }
      const event_id = pushEvent("site.https.disabled", site?.server_id ?? null, `HTTPS disabled for ${site?.domain ?? siteId}`)
      return { event_id }
    },

    async purgePageCache(siteId) {
      const site = sites.find((s) => s.id === siteId)
      const event_id = pushEvent("site.cache.purged", site?.server_id ?? null, `Page cache purged for ${site?.domain ?? siteId}`)
      return { event_id }
    },

    async purgeObjectCache(siteId) {
      const site = sites.find((s) => s.id === siteId)
      const event_id = pushEvent("site.object_cache.purged", site?.server_id ?? null, `Object cache purged for ${site?.domain ?? siteId}`)
      return { event_id }
    },

    async listSiteDomains(siteId) {
      const site = sites.find((s) => s.id === siteId)
      return (site?.additional_domains ?? []).map((d) => ({ ...d }))
    },

    async addSiteDomain(siteId, payload) {
      const site = sites.find((s) => s.id === siteId)
      if (site) {
        site.additional_domains = site.additional_domains ?? []
        const domId = 9000 + sites.reduce((n, x) => n + (x.additional_domains?.length ?? 0), 0)
        site.additional_domains.push({ id: domId, domain: payload.domain, redirect: { enabled: payload.redirect?.enabled ?? false, type: payload.redirect?.type ?? 301, destination: payload.redirect?.destination ?? site.domain }, created_at: new Date().toISOString() })
      }
      const event_id = pushEvent("site.domains.updated", site?.server_id ?? null, `Updating domains for ${site?.domain ?? siteId}`)
      return { event_id }
    },

    async listEvents(maxPages) {
      const limit = (maxPages ?? 3) * 100
      return events.slice(0, limit).map((e) => ({ ...e }))
    },

    async getEvent(id) {
      const found = events.find((e) => e.id === id)
      if (!found) throw new Error(`dev mode: no such event ${id}`)
      const polls = (eventPolls.get(id) ?? 0) + 1
      eventPolls.set(id, polls)
      if (polls >= EVENT_POLLS_BEFORE_DONE && found.status === "running") {
        found.status = "deployed"
        found.finished_at = new Date().toISOString()
      }
      return { ...found }
    },

    async upgradeSitePhp(siteId, phpVersion) {
      const site = sites.find((s) => s.id === siteId)
      if (site) site.php_version = phpVersion
      const event_id = pushEvent("site.php_version.updated", site?.server_id ?? null, `PHP updated to ${phpVersion} for ${site?.domain ?? siteId}`)
      return { event_id }
    },

    async rebootServer(serverId) {
      const server = servers.find((s) => s.id === serverId)
      if (server) server.reboot_required = false
      const event_id = pushEvent("server.rebooted", serverId, `Server ${server?.name ?? serverId} rebooted`)
      return { event_id }
    },

    async restartService(serverId, service: ServerService) {
      const server = servers.find((s) => s.id === serverId)
      const event_id = pushEvent(`server.service.${service}.restarted`, serverId, `${service} restarted on ${server?.name ?? serverId}`)
      return { event_id }
    },
  }
}

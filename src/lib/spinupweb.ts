// Deep links into the SpinupWP web app.
//
// A recurring pattern: when the API can't *act* on something (e.g. it exposes
// `upgrade_required` but has no upgrade endpoint), give the user a one-keystroke
// jump to the exact page in SpinupWP where they can. URLs are account-scoped:
//
//   https://spinupwp.app/{accountSlug}/servers/{id}
//   https://spinupwp.app/{accountSlug}/sites/{id}
//
// The API doesn't expose the account slug, so it comes from config. Without it
// we fall back to the dashboard root rather than guessing a broken URL.

const WEB_BASE = "https://spinupwp.app"

// Read an account slug from what a user types: the slug itself, or any dashboard
// URL pasted whole ("https://spinupwp.app/acme-agency/sites/123" → "acme-agency").
// Null when it doesn't look like a slug.
export function parseAccountSlug(input: string): string | null {
  let s = input.trim()
  const at = s.toLowerCase().indexOf("spinupwp.app/")
  if (at >= 0) s = s.slice(at + "spinupwp.app/".length)
  s = s.replace(/^\/+/, "").split(/[/?#]/)[0] ?? ""
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s) ? s : null
}

export function serverWebUrl(id: number, accountSlug: string | null): string {
  return accountSlug ? `${WEB_BASE}/${accountSlug}/servers/${id}` : WEB_BASE
}

export function siteWebUrl(id: number, accountSlug: string | null): string {
  return accountSlug ? `${WEB_BASE}/${accountSlug}/sites/${id}` : WEB_BASE
}

// Account Settings → Server Providers (where the server_provider ids live).
export function serverProvidersSettingsUrl(accountSlug: string | null): string {
  return accountSlug ? `${WEB_BASE}/${accountSlug}/settings#server-providers` : WEB_BASE
}

// A site's SFTP & SSH section — where you add an SSH key to the SITE USER so
// Spinup can connect to that site (the vanity flow deep-links here for the manual
// key step). The key is per-site, not a server sudo user.
export function siteSftpUrl(id: number, accountSlug: string | null): string {
  return accountSlug ? `${WEB_BASE}/${accountSlug}/sites/${id}#sftp` : WEB_BASE
}

// A site's Git settings (repo, branch, deploy script). The clone wizard links here
// when a dest site's deploy script needs re-entering: SpinupWP drops a script
// set through the API (see the create payload in store.tsx).
export function siteGitUrl(id: number, accountSlug: string | null): string {
  return accountSlug ? `${WEB_BASE}/${accountSlug}/sites/${id}#git` : WEB_BASE
}

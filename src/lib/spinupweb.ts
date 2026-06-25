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

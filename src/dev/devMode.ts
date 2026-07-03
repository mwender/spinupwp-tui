// Dev Mode: run Spinup entirely against an in-memory fixture fleet instead of the
// real SpinupWP API — no token, no network, nothing that can touch a live account.
// For demos, screenshots, and UI work. See src/dev/fixtures.ts + mockClient.ts.

export function isDevMode(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SPINUP_DEV_MODE?.trim() ?? "")
}

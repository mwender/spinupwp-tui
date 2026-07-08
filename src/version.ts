// The app's own identity. "SpinupTUI" is the app (a control center for your
// SpinupWP account); keep that distinct from "SpinupWP", the service it talks to.
import pkg from "../package.json" with { type: "json" }

export const APP_NAME = "SpinupTUI"
export const APP_VERSION = pkg.version
export const REPO_SLUG = "mwender/spinupwp-tui"
export const REPO_URL = `https://github.com/${REPO_SLUG}`

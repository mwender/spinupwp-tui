// The dashboard: boots the OpenTUI renderer and mounts either the first-run
// onboarding wizard (no token yet) or the main app wrapped in the data store.
// Loaded by src/index.tsx with a dynamic import, only once no headless command
// has claimed the arguments.

import { useCallback, useMemo, useState } from "react"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { hasToken, pinActiveProfile, setActiveProfile } from "../config.ts"
import { StoreProvider } from "./store.tsx"
import { App } from "./App.tsx"
import { AccountsContext, type AccountsApi } from "./accounts.tsx"
import { resetWpCoreJobs } from "./wpCoreJobs.tsx"
import { Onboarding } from "./Onboarding.tsx"
import { isDevMode } from "../dev/devMode.ts"

export async function startDashboard({ forceLogin }: { forceLogin: boolean }): Promise<void> {
  function Root() {
    const [configured, setConfigured] = useState(isDevMode() ? true : forceLogin ? false : hasToken())
    // The store is keyed by account: switching remounts it (see ui/accounts.tsx).
    const [account, setAccount] = useState(() => pinActiveProfile())
    const switchAccount = useCallback(async (id: string) => {
      await setActiveProfile(id)
      resetWpCoreJobs()
      setAccount(id)
    }, [])
    const accounts = useMemo<AccountsApi>(() => ({ switchAccount }), [switchAccount])
    if (!configured) {
      return <Onboarding onComplete={() => setConfigured(true)} />
    }
    return (
      <AccountsContext.Provider value={accounts}>
        <StoreProvider key={account}>
          <App />
        </StoreProvider>
      </AccountsContext.Provider>
    )
  }

  const renderer = await createCliRenderer()
  createRoot(renderer).render(<Root />)
}

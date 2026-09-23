// Account switching lives ABOVE the store: switching remounts <StoreProvider>
// keyed by the account, which is what guarantees a clean slate — every effect,
// poller and interval of the outgoing account is torn down by React, and every
// id-keyed cache (servers, sites, probes, jobs…) starts empty for the new one.
// See config.ts "Accounts" for how the profiles are stored.

import { createContext, useContext } from "react"

export interface AccountsApi {
  // Make `id` the active account and remount the app on it. The caller checks
  // the store's switchBlocker() first — nothing here waits for running work.
  switchAccount: (id: string) => Promise<void>
}

export const AccountsContext = createContext<AccountsApi | null>(null)

export function useAccounts(): AccountsApi {
  const ctx = useContext(AccountsContext)
  if (!ctx) throw new Error("useAccounts must be used within <AccountsContext.Provider>")
  return ctx
}

// Minimal first-party toast notifications.
//
// Replaces the @opentui-ui/toast package, which is stuck on a peer-dependency
// range from opentui's 0.1.x days and breaks against the @opentui/core 0.4.x
// line we're on (see CHANGELOG v0.24.2/v0.24.3). Every call site in this app
// only ever fires a single-line success message, so a small first-party
// implementation is simpler — and immune to upstream drift — than depending
// on a package built for a much larger feature set we don't use.
//
// A plain module-level subscriber list (rather than React state) so callers
// outside the component tree — store.tsx's async completion handlers — can
// fire a toast without needing a ref or context. ToastStack.tsx reads this
// via useSyncExternalStore.

export interface ToastItem {
  id: number
  message: string
}

const TOAST_DURATION_MS = 4000

let nextId = 1
let toasts: ToastItem[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getToasts(): ToastItem[] {
  return toasts
}

export const toast = {
  success(message: string) {
    const id = nextId++
    toasts = [...toasts, { id, message }]
    notify()
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id)
      notify()
    }, TOAST_DURATION_MS)
  },
}

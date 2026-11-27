import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import {
  type AppState,
  type AppStateStore,
  createAppStateStore,
} from './app_state_store.js'

const AppStateContext = createContext<AppStateStore | null>(null)

export type AppStateProviderProps = {
  children: React.ReactNode
  initialState?: Partial<AppState>
  store?: AppStateStore
  onChangeAppState?: (args: {
    newState: AppState
    oldState: AppState
  }) => void
}

/**
 * React context provider bridging the headless external `AppStateStore` into
 * React 19 via `useSyncExternalStore` for fine-grained slice subscriptions.
 */
export function AppStateProvider({
  children,
  initialState,
  store: externalStore,
  onChangeAppState,
}: AppStateProviderProps): React.ReactNode {
  const storeRef = useRef<AppStateStore | null>(externalStore ?? null)
  if (!storeRef.current) {
    storeRef.current = createAppStateStore(initialState, onChangeAppState)
  }

  const activeStore = externalStore ?? storeRef.current

  return (
    <AppStateContext.Provider value={activeStore}>
      {children}
    </AppStateContext.Provider>
  )
}

export function useAppStateStore(): AppStateStore {
  const store = useContext(AppStateContext)
  if (!store) {
    throw new Error('useAppStateStore must be used within an AppStateProvider')
  }
  return store
}

export function useOptionalAppStateStore(): AppStateStore | null {
  return useContext(AppStateContext)
}

/**
 * Subscribe to a derived slice of `AppState`.
 * Uses `useSyncExternalStore` with `Object.is` equality on the selector output
 * so unrelated store updates never trigger component re-renders.
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useAppStateStore()
  const selectorRef = useRef(selector)
  selectorRef.current = selector

  const getSnapshot = useCallback(
    () => selectorRef.current(store.getState()),
    [store],
  )

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export function useOptionalAppState<T>(
  selector: (state: AppState) => T,
): T | undefined {
  const store = useOptionalAppStateStore()
  const selectorRef = useRef(selector)
  selectorRef.current = selector

  const subscribe = useMemo(
    () => (store ? store.subscribe : () => () => {}),
    [store],
  )

  const getSnapshot = useCallback(
    () => (store ? selectorRef.current(store.getState()) : undefined),
    [store],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useSetAppState(): (
  updater: (prev: AppState) => AppState,
) => void {
  const store = useAppStateStore()
  return useCallback(
    (updater: (prev: AppState) => AppState) => {
      store.setState(updater)
    },
    [store],
  )
}

/**
 * Minimal reactive state store with Object.is bailout and synchronous
 * diff-driven side-effect hook. Zero React/Ink dependencies.
 */

type Listener = () => void
type OnChange<State> = (args: { newState: State; oldState: State }) => void

export type Store<State> = {
  getState: () => State
  setState: (updater: (prev: State) => State) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<State>(
  initialState: State,
  onChange?: OnChange<State>,
): Store<State> {
  let state = initialState
  const listeners = new Set<Listener>()

  return {
    getState: () => state,
    setState: (updater: (prev: State) => State) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

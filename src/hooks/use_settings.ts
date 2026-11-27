import { useOptionalAppState } from '../state/app_state.js'
import type { AppState } from '../state/app_state_store.js'
import { getInitialSettings } from '../utilities/settings/settings.js'

/**
 * Read current merged settings reactively from `AppState` (falling back to
 * initial settings outside `<AppStateProvider>`).
 */
export function useSettings(): AppState['settings'] {
  const fromStore = useOptionalAppState(s => s.settings)
  return fromStore ?? (getInitialSettings() as AppState['settings'])
}

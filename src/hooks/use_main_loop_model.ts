import { useOptionalAppState } from '../state/app_state.js'
import { getMainLoopModel } from '../utilities/model/model.js'

export function useMainLoopModel(): string {
  const fromSession = useOptionalAppState(s => s.mainLoopModelForSession)
  const fromState = useOptionalAppState(s => s.mainLoopModel)
  return fromSession ?? fromState ?? getMainLoopModel()
}

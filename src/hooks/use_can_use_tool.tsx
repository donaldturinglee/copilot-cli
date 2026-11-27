import { useCallback, useMemo, useRef, useState } from 'react'
import { persistPermissionUpdates } from '../components/permissions/permission_persistence.js'
import type {
  InteractivePermissionRequest,
  PermissionDialogResolution,
} from '../components/permissions/types.js'
import { useSetAppState } from '../state/app_state.js'
import type { CanUseToolFn } from '../types/forward.js'
import { applyPermissionUpdates } from '../utilities/permissions/permission_update.js'
import { applySettingsChange } from '../utilities/settings/apply_settings_change.js'
import { createCanUseTool } from './tool_permission/use_can_use_tool.js'

/**
 * Interactive REPL bridge connecting `QueryEngine`'s `canUseTool` hook to
 * inline `<PermissionRequest>` approval dialogs with persistent "Always allow"
 * rule writing (`settings.local.json`) and live `ToolPermissionContext` sync.
 */
export function useCanUseTool(): {
  canUseTool: CanUseToolFn
  pendingRequest: InteractivePermissionRequest | null
  resolvePendingRequest: (resolution: PermissionDialogResolution) => void
} {
  const setAppState = useSetAppState()
  const [queue, setQueue] = useState<InteractivePermissionRequest[]>([])
  const seqRef = useRef(0)

  const resolvePendingRequest = useCallback(
    (resolution: PermissionDialogResolution) => {
      setQueue(prev => {
        const [head, ...rest] = prev
        if (!head) return prev

        if (resolution.behavior === 'allow' && resolution.updatedPermissions?.length) {
          if (resolution.persistToDisk) {
            persistPermissionUpdates(resolution.updatedPermissions)
            applySettingsChange('localSettings', setAppState)
          }
          setAppState(appPrev => ({
            ...appPrev,
            toolPermissionContext: applyPermissionUpdates(
              appPrev.toolPermissionContext,
              resolution.updatedPermissions!,
            ),
          }))
        }

        head.resolve(resolution)
        return rest
      })
    },
    [setAppState],
  )

  const canUseTool = useMemo<CanUseToolFn>(() => {
    return createCanUseTool({
      prompter: ({ tool, input, askDecision, toolUseId, context }) =>
        new Promise<PermissionDialogResolution>(resolve => {
          const req: InteractivePermissionRequest = {
            id: String(++seqRef.current),
            tool,
            toolName: tool.name,
            input,
            askDecision,
            toolUseId,
            context,
            resolve,
          }
          setQueue(prev => [...prev, req])
        }),
    })
  }, [])

  return {
    canUseTool,
    pendingRequest: queue[0] ?? null,
    resolvePendingRequest,
  }
}

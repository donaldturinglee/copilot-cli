/**
 * Headless/Interactive `canUseTool` factory wrapping `hasPermissionsToUseTool()`
 * with optional interactive prompt callback and structured permission logging.
 */

import type { AnyTool, ToolUseContext } from '../../tool.js'
import type { CanUseToolFn } from '../../types/forward.js'
import type { AssistantMessage } from '../../types/message.js'
import type {
  PermissionAskDecision,
  PermissionDecision,
  PermissionUpdate,
} from '../../types/permissions.js'
import { hasPermissionsToUseTool } from '../../utilities/permissions/permissions.js'
import { applyPermissionUpdates } from '../../utilities/permissions/rule_matching.js'
import { logPermissionDecision } from './permission_logging.js'

export type InteractivePermissionPrompter = (params: {
  tool: AnyTool
  input: Record<string, unknown>
  askDecision: PermissionAskDecision<Record<string, unknown>>
  toolUseId: string
  context: ToolUseContext
}) => Promise<
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | {
      behavior: 'deny'
      message?: string
    }
>

/**
 * Builds a `CanUseToolFn` backed by `hasPermissionsToUseTool()`.
 * When `prompter` is provided, `ask` decisions delegate to the interactive
 * prompter; otherwise `ask` decisions fail closed to `deny`.
 */
export function createCanUseTool(options?: {
  prompter?: InteractivePermissionPrompter
}): CanUseToolFn {
  return async (
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseId,
  ): Promise<PermissionDecision<Record<string, unknown>>> => {
    const typedTool = tool as AnyTool
    const typedContext = toolUseContext as ToolUseContext
    const typedAssistant = assistantMessage as AssistantMessage

    const decision = await hasPermissionsToUseTool(
      typedTool,
      input,
      typedContext,
      typedAssistant,
      toolUseId,
    )

    if (decision.behavior === 'ask' && options?.prompter) {
      const response = await options.prompter({
        tool: typedTool,
        input: decision.updatedInput ?? input,
        askDecision: decision,
        toolUseId,
        context: typedContext,
      })

      if (response.behavior === 'allow') {
        if (response.updatedPermissions?.length) {
          typedContext.setAppState?.(prev => ({
            ...prev,
            toolPermissionContext: applyPermissionUpdates(
              prev.toolPermissionContext,
              response.updatedPermissions!,
            ),
          }))
        }
        const allowDecision: PermissionDecision<Record<string, unknown>> = {
          behavior: 'allow',
          updatedInput: response.updatedInput ?? decision.updatedInput ?? input,
          decisionReason: { type: 'other', reason: 'user-approved' },
          toolUseId,
        }
        logPermissionDecision(typedTool.name, allowDecision)
        return allowDecision
      }

      const denyDecision: PermissionDecision<Record<string, unknown>> = {
        behavior: 'deny',
        message: response.message ?? 'User rejected tool execution.',
        decisionReason: { type: 'other', reason: 'user-rejected' },
        toolUseId,
      }
      logPermissionDecision(typedTool.name, denyDecision)
      return denyDecision
    }

    logPermissionDecision(typedTool.name, decision)
    return decision
  }
}

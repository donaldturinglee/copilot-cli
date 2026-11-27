/**
 * `EnterPlanModeTool` (`EnterPlanMode`):
 * Saves the current permission mode to `prePlanMode`, switches `mode` to
 * `'plan'`, and returns the session plan file path.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { handlePlanModeTransition } from '../../bootstrap/state.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { getPlanFilePath } from '../../utilities/plans.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from './constants.js'
import {
  ENTER_PLAN_MODE_TOOL_DESCRIPTION,
  ENTER_PLAN_MODE_TOOL_PROMPT,
} from './prompt.js'

const EnterPlanModeInputSchema = z.object({})
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>

export interface EnterPlanModeOutput {
  message: string
  planFilePath: string
}

export const EnterPlanModeTool = buildTool<
  EnterPlanModeInput,
  EnterPlanModeOutput
>({
  name: ENTER_PLAN_MODE_TOOL_NAME,
  searchHint: 'enter read-only planning mode before making code changes',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: EnterPlanModeInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  requiresUserInteraction: () => true,
  interruptBehavior: () => 'block',

  async description() {
    return ENTER_PLAN_MODE_TOOL_DESCRIPTION
  },

  async prompt() {
    return ENTER_PLAN_MODE_TOOL_PROMPT
  },

  async validateInput(_input, context) {
    if (context.agentId) {
      return {
        result: false,
        message: 'EnterPlanMode cannot be called from inside a subagent.',
        errorCode: 1,
      }
    }
    const mode = context.getAppState?.().toolPermissionContext.mode
    if (mode === 'plan') {
      return {
        result: false,
        message: 'Already in plan mode.',
        errorCode: 2,
      }
    }
    return { result: true }
  },

  async call(_input, context: ToolUseContext) {
    const planFilePath = getPlanFilePath(context.agentId)
    const prevMode = context.getAppState?.().toolPermissionContext.mode ?? 'default'

    handlePlanModeTransition(prevMode, 'plan')
    context.setAppState?.(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        prePlanMode: prev.toolPermissionContext.mode,
        mode: 'plan',
      },
    }))

    return {
      data: {
        message: `Entered plan mode. Explore the codebase with read-only tools and write your plan to ${planFilePath}. Call ExitPlanMode when ready to proceed.`,
        planFilePath,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: output.message,
    }
  },
})

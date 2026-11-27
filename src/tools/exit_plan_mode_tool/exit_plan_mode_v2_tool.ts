/**
 * `ExitPlanModeV2Tool` (`ExitPlanMode`):
 * Validates active `'plan'` mode, reads the written plan file, restores
 * `prePlanMode ?? 'default'`, and records plan-exit state.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import {
  handlePlanModeTransition,
  setHasExitedPlanMode,
} from '../../bootstrap/state.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { getPlan, getPlanFilePath } from '../../utilities/plans.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from './constants.js'
import {
  EXIT_PLAN_MODE_TOOL_DESCRIPTION,
  EXIT_PLAN_MODE_TOOL_PROMPT,
} from './prompt.js'

const AllowedPromptSchema = z.object({
  tool: z.literal('Bash'),
  prompt: z.string(),
})

const ExitPlanModeInputSchema = z.object({
  allowedPrompts: z
    .array(AllowedPromptSchema)
    .optional()
    .describe('Optional prompt-based Bash permissions requested for implementation'),
})

export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>

export interface ExitPlanModeOutput {
  plan: string | null
  isAgent: boolean
  filePath?: string
  hasTaskTool?: boolean
}

export const ExitPlanModeV2Tool = buildTool<
  ExitPlanModeInput,
  ExitPlanModeOutput
>({
  name: EXIT_PLAN_MODE_TOOL_NAME,
  searchHint: 'exit planning mode and begin implementing the plan',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: ExitPlanModeInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  requiresUserInteraction: () => true,
  interruptBehavior: () => 'block',

  async description() {
    return EXIT_PLAN_MODE_TOOL_DESCRIPTION
  },

  async prompt() {
    return EXIT_PLAN_MODE_TOOL_PROMPT
  },

  async validateInput(_input, context) {
    const mode = context.getAppState?.().toolPermissionContext.mode
    if (mode !== undefined && mode !== 'plan') {
      return {
        result: false,
        message: `ExitPlanMode can only be called while in plan mode (current mode: ${mode}).`,
        errorCode: 1,
      }
    }
    return { result: true }
  },

  async call(_input, context: ToolUseContext) {
    const isAgent = Boolean(context.agentId)
    const filePath = getPlanFilePath(context.agentId)
    const plan = getPlan(context.agentId)

    const currentPerm = context.getAppState?.().toolPermissionContext
    const restoredMode = currentPerm?.prePlanMode ?? 'default'

    setHasExitedPlanMode(true)
    handlePlanModeTransition('plan', restoredMode)

    context.setAppState?.(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: prev.toolPermissionContext.prePlanMode ?? 'default',
        prePlanMode: undefined,
      },
    }))

    return {
      data: {
        plan,
        isAgent,
        filePath,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    const body = output.plan
      ? `User approved your plan at ${output.filePath}. You may now proceed with implementation.\n\n## Approved Plan\n${output.plan}`
      : `Exited plan mode (${output.filePath ?? 'no plan file written'}). You may now proceed with implementation.`
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: body,
    }
  },
})

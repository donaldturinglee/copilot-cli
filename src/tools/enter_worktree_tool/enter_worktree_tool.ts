/**
 * `EnterWorktreeTool` (`EnterWorktree`):
 * Creates an isolated git worktree under `.copilot/worktrees/<name>` and
 * transitions CWD into it.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { buildTool } from '../../tool.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  validateWorktreeSlug,
} from '../../utilities/worktree.js'
import { isWorktreeModeEnabled } from '../../utilities/worktree_mode_enabled.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import {
  ENTER_WORKTREE_TOOL_DESCRIPTION,
  ENTER_WORKTREE_TOOL_PROMPT,
} from './prompt.js'

const EnterWorktreeInputSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      'Optional name/slug for the worktree (alphanumeric, ".", "_", "-"; random name generated if omitted)',
    ),
})

export type EnterWorktreeInput = z.infer<typeof EnterWorktreeInputSchema>

export interface EnterWorktreeOutput {
  worktreePath: string
  worktreeBranch: string
  message: string
}

export const EnterWorktreeTool = buildTool<
  EnterWorktreeInput,
  EnterWorktreeOutput
>({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'create and enter an isolated git worktree',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: EnterWorktreeInputSchema,

  isEnabled: () => isWorktreeModeEnabled(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  interruptBehavior: () => 'block',

  async description() {
    return ENTER_WORKTREE_TOOL_DESCRIPTION
  },

  async prompt() {
    return ENTER_WORKTREE_TOOL_PROMPT
  },

  async validateInput(input) {
    if (getCurrentWorktreeSession()) {
      return {
        result: false,
        message: 'Already inside an active worktree session. Call ExitWorktree first.',
        errorCode: 1,
      }
    }
    if (input.name !== undefined) {
      const check = validateWorktreeSlug(input.name)
      if (!check.valid) {
        return {
          result: false,
          message: check.error ?? 'Invalid worktree name.',
          errorCode: 2,
        }
      }
    }
    return { result: true }
  },

  async call(input) {
    const session = await createWorktreeForSession(input.name)
    return {
      data: {
        worktreePath: session.worktreePath,
        worktreeBranch: session.worktreeBranch,
        message: `Created and entered git worktree at ${session.worktreePath} on branch ${session.worktreeBranch}.`,
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

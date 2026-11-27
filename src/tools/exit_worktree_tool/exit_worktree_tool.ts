/**
 * `ExitWorktreeTool` (`ExitWorktree`):
 * Exits an active worktree session, keeping or removing the worktree with
 * fail-closed uncommitted/unmerged change detection.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { buildTool } from '../../tool.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
} from '../../utilities/worktree.js'
import { isWorktreeModeEnabled } from '../../utilities/worktree_mode_enabled.js'
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js'
import {
  EXIT_WORKTREE_TOOL_DESCRIPTION,
  EXIT_WORKTREE_TOOL_PROMPT,
} from './prompt.js'

const ExitWorktreeInputSchema = z.object({
  action: z
    .enum(['keep', 'remove'])
    .describe('"keep" leaves worktree and branch intact; "remove" deletes both'),
  discard_changes: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Required to be true when action is "remove" and uncommitted files or unmerged commits exist',
    ),
})

export type ExitWorktreeInput = z.infer<typeof ExitWorktreeInputSchema>

export interface ExitWorktreeOutput {
  action: 'keep' | 'remove'
  originalCwd: string
  worktreePath: string
  worktreeBranch: string
  discardedFiles?: number
  discardedCommits?: number
  message: string
}

export const ExitWorktreeTool = buildTool<
  ExitWorktreeInput,
  ExitWorktreeOutput
>({
  name: EXIT_WORKTREE_TOOL_NAME,
  searchHint: 'exit a git worktree session and keep or remove it',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: ExitWorktreeInputSchema,

  isEnabled: () => isWorktreeModeEnabled(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: input => input.action === 'remove',
  interruptBehavior: () => 'block',

  async description() {
    return EXIT_WORKTREE_TOOL_DESCRIPTION
  },

  async prompt() {
    return EXIT_WORKTREE_TOOL_PROMPT
  },

  async validateInput() {
    if (!getCurrentWorktreeSession()) {
      return {
        result: false,
        message: 'No active worktree session to exit.',
        errorCode: 1,
      }
    }
    return { result: true }
  },

  async call(input) {
    if (input.action === 'keep') {
      const session = keepWorktree()
      return {
        data: {
          action: 'keep',
          originalCwd: session.originalCwd,
          worktreePath: session.worktreePath,
          worktreeBranch: session.worktreeBranch,
          message: `Exited worktree and restored working directory to ${session.originalCwd}. Kept worktree at ${session.worktreePath} (branch ${session.worktreeBranch}).`,
        },
      }
    }

    const { session, discardedFiles, discardedCommits } = await cleanupWorktree(
      { discardChanges: Boolean(input.discard_changes) },
    )
    return {
      data: {
        action: 'remove',
        originalCwd: session.originalCwd,
        worktreePath: session.worktreePath,
        worktreeBranch: session.worktreeBranch,
        discardedFiles,
        discardedCommits,
        message: `Removed worktree ${session.worktreePath} (branch ${session.worktreeBranch}) and restored working directory to ${session.originalCwd}.`,
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

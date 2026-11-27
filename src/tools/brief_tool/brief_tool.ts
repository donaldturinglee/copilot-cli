/**
 * `BriefTool` (`SendUserMessage`, alias `Brief`):
 * Delivers structured user-facing messages and optional resolved file
 * attachments.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { BRIEF_TOOL_NAME } from '../../constants/tools.js'
import { buildTool } from '../../tool.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import {
  type ResolvedBriefAttachment,
  resolveBriefAttachments,
} from './attachments.js'
import { BRIEF_TOOL_DESCRIPTION, BRIEF_TOOL_PROMPT } from './prompt.js'

const BriefInputSchema = z.object({
  message: z.string().min(1).describe('The markdown message to send to the user'),
  attachments: z
    .array(z.string())
    .optional()
    .describe('Optional file paths to attach alongside the message'),
  status: z
    .enum(['normal', 'proactive'])
    .default('normal')
    .describe('"normal" for direct replies or "proactive" for status updates'),
})

export type BriefInput = z.infer<typeof BriefInputSchema>

export interface BriefOutput {
  message: string
  attachments?: ResolvedBriefAttachment[]
  sentAt: string
}

export const BriefTool = buildTool<BriefInput, BriefOutput>({
  name: BRIEF_TOOL_NAME,
  aliases: ['Brief'],
  searchHint: 'send a direct message or progress update to the user',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: BriefInputSchema,

  isEnabled: () =>
    isEnvTruthy(process.env.COPILOT_CLI_ENABLE_BRIEF_TOOL) ||
    process.env.NODE_ENV === 'test',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'block',

  async description() {
    return BRIEF_TOOL_DESCRIPTION
  },

  async prompt() {
    return BRIEF_TOOL_PROMPT
  },

  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },

  async call(input) {
    const attachments = resolveBriefAttachments(input.attachments)
    return {
      data: {
        message: input.message,
        ...(attachments.length > 0 ? { attachments } : {}),
        sentAt: new Date().toISOString(),
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Message delivered to user at ${output.sentAt}.`,
    }
  },
})

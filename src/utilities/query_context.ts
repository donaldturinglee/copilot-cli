/**
 * Parallel system prompt + user/system context fetching and fallback
 * `CacheSafeParams` reconstruction for side questions.
 */

import { getSystemPrompt } from '../constants/prompts.js'
import { getSystemContext, getUserContext } from '../context.js'
import type { McpServerConnection, Tool, ToolUseContext } from '../types/forward.js'
import type { Message } from '../types/message.js'
import type { SystemPrompt } from './system_prompt_type.js'

export interface FetchSystemPromptPartsParams {
  tools: readonly Tool[]
  mainLoopModel: string
  additionalWorkingDirectories?: readonly string[]
  mcpClients?: readonly McpServerConnection[]
  customSystemPrompt?: string
}

export interface SystemPromptParts {
  defaultSystemPrompt: string[]
  userContext: Record<string, string>
  systemContext: Record<string, string>
}

/**
 * Fetches default system prompt sections, user context (`CLAUDE.md` + date —
 * always loaded even with `customSystemPrompt`), and system context (git status)
 * in parallel.
 */
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories = [],
  mcpClients = [],
  customSystemPrompt,
}: FetchSystemPromptPartsParams): Promise<SystemPromptParts> {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(
          tools,
          mainLoopModel,
          additionalWorkingDirectories,
          mcpClients,
        ),
    getUserContext(),
    customSystemPrompt !== undefined
      ? Promise.resolve<Record<string, string>>({})
      : getSystemContext(),
  ])

  return {
    defaultSystemPrompt,
    userContext,
    systemContext,
  }
}

/**
 * Rebuilds a cache-safe snapshot for side questions when a main turn has not
 * finished yet, trimming any in-flight trailing assistant message (`stop_reason === null`).
 */
export function buildSideQuestionFallbackParams(params: {
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
  messages: readonly Message[]
}): {
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
} {
  const forkContextMessages = [...params.messages]
  const last = forkContextMessages.at(-1)
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    forkContextMessages.pop()
  }
  return {
    systemPrompt: params.systemPrompt,
    userContext: params.userContext,
    systemContext: params.systemContext,
    toolUseContext: params.toolUseContext,
    forkContextMessages,
  }
}

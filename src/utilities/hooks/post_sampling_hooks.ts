/**
 * Shared context type for post-sampling / stop-hook orchestration.
 */

import type { QuerySource } from '../../constants/query_source.js'
import type { ToolUseContext } from '../../tool.js'
import type { Message } from '../../types/message.js'
import type { SystemPrompt } from '../system_prompt_type.js'

export interface ReplHookContext {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
  querySource: QuerySource
}

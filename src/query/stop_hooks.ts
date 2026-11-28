/**
 * `Stop` / `SubagentStop` hook orchestration wired into `query()`'s
 * `QueryDeps.handleStopHooks` slot.
 *
 * When a Stop hook blocks (via exit code 2 or `{ decision: 'block', reason }`),
 * returns `blockingErrors` user messages so `query()` continues for another
 * turn with `stopHookActive = true` (preventing infinite loops when hooks check
 * `stop_hook_active`). When a hook sets `continue: false`, sets
 * `preventContinuation: true`.
 */

import type { QuerySource } from '../constants/query_source.js'
import { isExtractModeActive } from '../memdir/paths.js'
import type { StopHookResult } from '../query/deps.js'
import { executeAutoDream } from '../services/auto_dream/auto_dream.js'
import { executeExtractMemories } from '../services/extract_memories/extract_memories.js'
import type { ToolUseContext } from '../tool.js'
import type {
  AssistantMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
} from '../types/message.js'
import { createAttachmentMessage } from '../utilities/attachments.js'
import {
  createCacheSafeParams,
  saveCacheSafeParams,
} from '../utilities/cache_safe_params.js'
import { isBareMode } from '../utilities/env_utils.js'
import { executeStopHooks } from '../utilities/hooks.js'
import { logError } from '../utilities/log.js'
import {
  createUserMessage,
  getAssistantMessageText,
} from '../utilities/messages.js'
import type { SystemPrompt } from '../utilities/system_prompt_type.js'

export async function* handleStopHooks(
  messagesForQuery: Message[],
  assistantMessages: AssistantMessage[],
  systemPrompt: SystemPrompt,
  userContext: Record<string, string>,
  systemContext: Record<string, string>,
  toolUseContext: ToolUseContext,
  querySource: QuerySource,
  stopHookActive = false,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  StopHookResult
> {
  const allMessages = [...messagesForQuery, ...assistantMessages]

  if (querySource === 'repl_main_thread' || querySource === 'sdk') {
    saveCacheSafeParams(
      createCacheSafeParams({
        messages: allMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
      }),
    )
  }

  const lastAssistant = assistantMessages[assistantMessages.length - 1]
  const lastAssistantText = lastAssistant
    ? getAssistantMessageText(lastAssistant)
    : undefined

  const permissionMode = toolUseContext.getAppState?.().toolPermissionContext.mode

  const aggregated = await executeStopHooks({
    stopHookActive,
    lastAssistantMessage: lastAssistantText,
    permissionMode,
    agentId: toolUseContext.agentId,
    agentType: toolUseContext.agentType,
    toolUseContext,
    messages: allMessages,
    signal: toolUseContext.abortController.signal,
  })

  for (const msg of aggregated.messages) {
    yield msg
  }

  if (aggregated.preventContinuation) {
    yield createAttachmentMessage({
      type: 'hook_stopped_continuation',
      stopReason: aggregated.stopReason,
    })
    return {
      blockingErrors: [],
      preventContinuation: true,
    }
  }

  const blockingMessages: Message[] = []
  if (aggregated.blockingErrors.length > 0) {
    const combinedReason = aggregated.blockingErrors
      .map(err => `Stop hook blocked completion (${err.command}): ${err.blockingError}`)
      .join('\n')

    const feedbackMsg = createUserMessage({
      content: combinedReason,
    })
    blockingMessages.push(feedbackMsg)
  }

  if (
    blockingMessages.length === 0 &&
    !isBareMode() &&
    !toolUseContext.agentId &&
    (querySource === 'repl_main_thread' || querySource === 'sdk')
  ) {
    if (isExtractModeActive()) {
      void executeExtractMemories(
        {
          messages: allMessages,
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
        },
        toolUseContext.appendSystemMessage,
      ).catch(err => logError(err))
    }

    void executeAutoDream(
      {
        messages: allMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
      },
      toolUseContext.appendSystemMessage,
    ).catch(err => logError(err))
  }

  return {
    blockingErrors: blockingMessages,
    preventContinuation: false,
  }
}

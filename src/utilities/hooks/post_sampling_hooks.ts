/**
 * Shared context type and registry for post-sampling / stop-hook orchestration
 * (used by Session Memory and other background post-turn observers).
 */

import type { QuerySource } from '../../constants/query_source.js'
import type { ToolUseContext } from '../../tool.js'
import type { Message } from '../../types/message.js'
import { logError } from '../log.js'
import type { SystemPrompt } from '../system_prompt_type.js'

export interface ReplHookContext {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
  querySource: QuerySource
}

export type PostSamplingHookFn = (context: ReplHookContext) => Promise<void> | void

const postSamplingHooks = new Set<PostSamplingHookFn>()

/**
 * Registers an async hook executed after main-thread model sampling turns.
 * Returns an unsubscribe callback.
 */
export function registerPostSamplingHook(fn: PostSamplingHookFn): () => void {
  postSamplingHooks.add(fn)
  return () => {
    postSamplingHooks.delete(fn)
  }
}

/**
 * Invokes all registered post-sampling hooks without letting any hook error
 * interrupt the main turn loop.
 */
export async function runPostSamplingHooks(
  context: ReplHookContext,
): Promise<void> {
  if (postSamplingHooks.size === 0) {
    return
  }
  const tasks = Array.from(postSamplingHooks).map(async hook => {
    try {
      await hook(context)
    } catch (error) {
      logError(error)
    }
  })
  await Promise.allSettled(tasks)
}

export function getRegisteredPostSamplingHookCount(): number {
  return postSamplingHooks.size
}

export function clearPostSamplingHooksForTesting(): void {
  postSamplingHooks.clear()
}

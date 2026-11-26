/**
 * Cache-safe query parameter snapshot store shared between `query()` and
 * `runForkedAgent()` without introducing a circular module import.
 */

import type { ToolUseContext } from '../types/forward.js'
import type { Message } from '../types/message.js'
import type { SystemPrompt } from './system_prompt_type.js'

export interface CacheSafeParams {
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}

let lastCacheSafeParams: CacheSafeParams | null = null

/**
 * Stores the most recent main-thread cache-safe parameters for cache-sharing forks.
 */
export function saveCacheSafeParams(params: CacheSafeParams | null): void {
  lastCacheSafeParams = params
}

/**
 * Returns the latest captured `CacheSafeParams` snapshot, or `null`.
 */
export function getLastCacheSafeParams(): CacheSafeParams | null {
  return lastCacheSafeParams
}

/**
 * Creates a `CacheSafeParams` snapshot object from current turn context.
 */
export function createCacheSafeParams(context: {
  systemPrompt: SystemPrompt
  userContext: Record<string, string>
  systemContext: Record<string, string>
  toolUseContext: ToolUseContext
  messages: Message[]
}): CacheSafeParams {
  return {
    systemPrompt: context.systemPrompt,
    userContext: context.userContext,
    systemContext: context.systemContext,
    toolUseContext: context.toolUseContext,
    forkContextMessages: [...context.messages],
  }
}

/**
 * Effective system prompt selection precedence (`overrideSystemPrompt` >
 * coordinator > custom agent > `customSystemPrompt` > `defaultSystemPrompt` +
 * `appendSystemPrompt`).
 */

import { asSystemPrompt, type SystemPrompt } from './system_prompt_type.js'

export { asSystemPrompt, type SystemPrompt }

export interface BuildEffectiveSystemPromptParams {
  defaultSystemPrompt: readonly string[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  overrideSystemPrompt?: string
  coordinatorSystemPrompt?: string
  mainThreadAgentPrompt?: string
  isProactiveMode?: boolean
}

/**
 * Selects and assembles the effective branded `SystemPrompt` according to
 * strict precedence rules.
 */
export function buildEffectiveSystemPrompt({
  defaultSystemPrompt,
  customSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
  coordinatorSystemPrompt,
  mainThreadAgentPrompt,
  isProactiveMode = false,
}: BuildEffectiveSystemPromptParams): SystemPrompt {
  if (overrideSystemPrompt !== undefined) {
    return asSystemPrompt([overrideSystemPrompt])
  }

  const append = appendSystemPrompt ? [appendSystemPrompt] : []

  if (coordinatorSystemPrompt && !mainThreadAgentPrompt) {
    return asSystemPrompt([coordinatorSystemPrompt, ...append])
  }

  if (mainThreadAgentPrompt) {
    if (isProactiveMode) {
      return asSystemPrompt([
        ...defaultSystemPrompt,
        `\n# Custom Agent Instructions\n${mainThreadAgentPrompt}`,
        ...append,
      ])
    }
    return asSystemPrompt([mainThreadAgentPrompt, ...append])
  }

  if (customSystemPrompt !== undefined) {
    return asSystemPrompt([customSystemPrompt, ...append])
  }

  return asSystemPrompt([...defaultSystemPrompt, ...append])
}

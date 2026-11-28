/**
 * Tier 2c API-level context management strategy builder
 * (`clear_thinking_20251015` and optional `clear_tool_uses_20250919`).
 */

import {
  BASH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../../constants/tools.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'

export const DEFAULT_MAX_INPUT_TOKENS = 180_000
export const DEFAULT_TARGET_INPUT_TOKENS = 40_000

export const TOOLS_CLEARABLE_RESULTS: readonly string[] = [
  BASH_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
]

export const TOOLS_CLEARABLE_USES: readonly string[] = [
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]

export interface ClearToolUsesStrategy {
  type: 'clear_tool_uses_20250919'
  trigger?: { type: 'input_tokens'; value: number }
  keep?: { type: 'tool_uses'; value: number }
  clear_tool_inputs?: boolean | string[]
  exclude_tools?: string[]
  clear_at_least?: { type: 'input_tokens'; value: number }
}

export interface ClearThinkingStrategy {
  type: 'clear_thinking_20251015'
  keep: { type: 'thinking_turns'; value: number } | 'all'
}

export type ContextEditStrategy = ClearToolUsesStrategy | ClearThinkingStrategy

export interface ContextManagementConfig {
  edits: ContextEditStrategy[]
}

export interface ApiContextManagementOptions {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
}

function parseEnvPositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.floor(parsed)
}

/**
 * Builds the Anthropic API `context_management` payload (`edits[]`):
 * - Always emits `clear_thinking_20251015` when extended thinking is active
 *   and `redact-thinking` beta is not active: `keep: 'all'` normally, or
 *   `keep: { type: 'thinking_turns', value: 1 }` once `clearAllThinking` has
 *   latched after cache expiry.
 * - Optionally emits `clear_tool_uses_20250919` for internal (`ant`) runs when
 *   explicitly requested via environment flags.
 */
export function getApiContextManagement(
  options: ApiContextManagementOptions = {},
): ContextManagementConfig | undefined {
  const strategies: ContextEditStrategy[] = []

  if (options.hasThinking && !options.isRedactThinkingActive) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: options.clearAllThinking
        ? { type: 'thinking_turns', value: 1 }
        : 'all',
    })
  }

  if (process.env.USER_TYPE === 'ant') {
    const useClearToolResults = isEnvTruthy(
      process.env.USE_API_CLEAR_TOOL_RESULTS,
    )
    const useClearToolUses = isEnvTruthy(process.env.USE_API_CLEAR_TOOL_USES)

    if (useClearToolResults || useClearToolUses) {
      const triggerThreshold = parseEnvPositiveInt(
        process.env.API_MAX_INPUT_TOKENS,
        DEFAULT_MAX_INPUT_TOKENS,
      )
      const keepTarget = parseEnvPositiveInt(
        process.env.API_TARGET_INPUT_TOKENS,
        DEFAULT_TARGET_INPUT_TOKENS,
      )
      const clearAtLeast = Math.max(1, triggerThreshold - keepTarget)

      const strategy: ClearToolUsesStrategy = {
        type: 'clear_tool_uses_20250919',
        trigger: { type: 'input_tokens', value: triggerThreshold },
        keep: { type: 'tool_uses', value: 5 },
        clear_at_least: { type: 'input_tokens', value: clearAtLeast },
        ...(useClearToolResults
          ? { clear_tool_inputs: [...TOOLS_CLEARABLE_RESULTS] }
          : {}),
        ...(useClearToolUses
          ? { exclude_tools: [...TOOLS_CLEARABLE_USES] }
          : {}),
      }
      strategies.push(strategy)
    }
  }

  if (strategies.length === 0) {
    return undefined
  }
  return { edits: strategies }
}

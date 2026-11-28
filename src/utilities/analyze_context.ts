/**
 * Detailed `/context` window breakdown (`analyzeContextBreakdown`): computes
 * system prompt, tool schema, memory files, conversation messages, autocompact
 * buffer, and free space token categories.
 */

import { roughTokenCountEstimation } from '../services/token_estimation.js'
import type { Tool } from '../types/forward.js'
import type { Message } from '../types/message.js'
import { getMemoryFiles } from './claudemd.js'
import { COMPACT_MAX_OUTPUT_TOKENS, getContextWindowForModel } from './context.js'
import { analyzeContext, type TokenStats } from './context_analysis.js'
import { getMainLoopModel } from './model/model.js'
import { jsonStringify } from './slow_operations.js'

export const TOOL_TOKEN_COUNT_OVERHEAD = 500
export const AUTOCOMPACT_RESERVE_TOKENS = 13_000

export interface ContextCategoryBreakdown {
  name: string
  tokens: number
  percentage: number
}

export interface ContextBreakdownResult {
  model: string
  contextWindow: number
  totalTokens: number
  freeTokens: number
  autocompactBufferTokens: number
  categories: ContextCategoryBreakdown[]
  messageStats: TokenStats
  memoryFileCount: number
  toolCount: number
}

/**
 * Computes a complete category-by-category context window usage breakdown for
 * the `/context` slash command and visualization panel.
 */
export async function analyzeContextBreakdown(params: {
  messages: readonly Message[]
  tools?: readonly Tool[]
  systemPrompt?: readonly string[]
  model?: string
}): Promise<ContextBreakdownResult> {
  const model = params.model ?? getMainLoopModel()
  const contextWindow = getContextWindowForModel(model)
  const messageStats = analyzeContext(params.messages)

  const systemPromptTokens = params.systemPrompt
    ? roughTokenCountEstimation(params.systemPrompt.join('\n'))
    : 0

  const tools = params.tools ?? []
  const rawToolsTokens = tools.reduce(
    (sum, tool) =>
      sum +
      roughTokenCountEstimation(
        `${tool.name}:${String((tool as { searchHint?: unknown }).searchHint ?? '')}:${jsonStringify((tool as { inputJSONSchema?: unknown }).inputJSONSchema ?? {})}`,
      ),
    0,
  )
  const toolTokens =
    tools.length > 0
      ? Math.max(0, rawToolsTokens - Math.min(rawToolsTokens, TOOL_TOKEN_COUNT_OVERHEAD))
      : 0

  const memoryFiles = await getMemoryFiles().catch(() => [])
  const memoryTokens = memoryFiles.reduce(
    (sum, file) => sum + roughTokenCountEstimation(file.content),
    0,
  )

  const autocompactBufferTokens =
    COMPACT_MAX_OUTPUT_TOKENS + AUTOCOMPACT_RESERVE_TOKENS
  const totalTokens =
    systemPromptTokens + toolTokens + memoryTokens + messageStats.total
  const freeTokens = Math.max(
    0,
    contextWindow - totalTokens - autocompactBufferTokens,
  )

  const pct = (tokens: number): number =>
    contextWindow > 0 ? Math.round((tokens / contextWindow) * 1000) / 10 : 0

  const categories: ContextCategoryBreakdown[] = [
    {
      name: 'System prompt',
      tokens: systemPromptTokens,
      percentage: pct(systemPromptTokens),
    },
    {
      name: 'System tools',
      tokens: toolTokens,
      percentage: pct(toolTokens),
    },
    {
      name: 'Memory files',
      tokens: memoryTokens,
      percentage: pct(memoryTokens),
    },
    {
      name: 'Messages',
      tokens: messageStats.total,
      percentage: pct(messageStats.total),
    },
    {
      name: 'Autocompact buffer',
      tokens: autocompactBufferTokens,
      percentage: pct(autocompactBufferTokens),
    },
    {
      name: 'Free space',
      tokens: freeTokens,
      percentage: pct(freeTokens),
    },
  ]

  return {
    model,
    contextWindow,
    totalTokens,
    freeTokens,
    autocompactBufferTokens,
    categories,
    messageStats,
    memoryFileCount: memoryFiles.length,
    toolCount: tools.length,
  }
}

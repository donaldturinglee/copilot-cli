import {
  getTotalApiDuration,
  getTotalCost,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
} from '../cost_tracker.js'
import type { Message } from '../types/message.js'

export type SessionStatsSummary = {
  messageCount: number
  userTurns: number
  assistantTurns: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
  totalCostUsd: number
  apiDurationMs: number
  wallDurationMs: number
  linesAdded: number
  linesRemoved: number
}

export function computeSessionStats(
  messages: readonly Message[],
): SessionStatsSummary {
  let userTurns = 0
  let assistantTurns = 0
  let toolCalls = 0

  for (const m of messages) {
    if (m.type === 'user' && !m.isMeta) userTurns++
    else if (m.type === 'assistant') {
      assistantTurns++
      if (Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_use') toolCalls++
        }
      }
    }
  }

  return {
    messageCount: messages.length,
    userTurns,
    assistantTurns,
    toolCalls,
    inputTokens: getTotalInputTokens(),
    outputTokens: getTotalOutputTokens(),
    totalCostUsd: getTotalCost(),
    apiDurationMs: getTotalApiDuration(),
    wallDurationMs: getTotalDuration(),
    linesAdded: getTotalLinesAdded(),
    linesRemoved: getTotalLinesRemoved(),
  }
}

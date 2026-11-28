/**
 * Commit and PR attribution text formatting (`getAttributionTexts`,
 * `getEnhancedPrAttribution`) and post-compact transcript stats
 * (`getTranscriptStats`).
 */

import { stat } from 'fs/promises'
import { getIsRemoteMode } from '../bootstrap/state.js'
import { PRODUCT_URL } from '../constants/product.js'
import type { AppState } from '../state/app_state_store.js'
import type { Entry } from '../types/logs.js'
import type { Message } from '../types/message.js'
import { sanitizeModelName } from './commit_attribution.js'
import { parseJsonl } from './json.js'
import { isCompactBoundaryMessage } from './messages.js'
import { getMainLoopModel, getMarketingNameForModel } from './model/model.js'
import { getTranscriptPath } from './session_storage.js'
import { readTranscriptForLoad } from './session_storage_portable.js'
import { getInitialSettings } from './settings/settings.js'
import { isUndercover } from './undercover.js'

export interface AttributionTexts {
  commit: string
  pr: string
}

/**
 * Resolves commit and PR attribution trailers according to settings precedence:
 * `settings.attribution.{commit,pr}` > deprecated `includeCoAuthoredBy === false`
 * > default model/product attribution (suppressed in undercover mode).
 */
export function getAttributionTexts(model?: string): AttributionTexts {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return { commit: '', pr: '' }
  }

  const settings = getInitialSettings()
  const resolvedModel = model ?? getMainLoopModel()
  const modelName = getMarketingNameForModel(resolvedModel) || 'Claude Opus 4.6'

  const defaultCommit =
    settings.includeCoAuthoredBy === false
      ? ''
      : `Co-Authored-By: ${modelName} <noreply@anthropic.com>`
  const defaultPr = getIsRemoteMode()
    ? `Generated with [Copilot CLI](${PRODUCT_URL})`
    : `Generated with [Copilot CLI](${PRODUCT_URL})`

  return {
    commit: settings.attribution?.commit ?? defaultCommit,
    pr: settings.attribution?.pr ?? defaultPr,
  }
}

/**
 * Counts human user prompts in `messages` after the last `compact_boundary`.
 */
export function countUserPromptsInMessages(
  messages: readonly Message[],
): number {
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundaryMessage(messages[i]!)) {
      start = i + 1
      break
    }
  }
  let count = 0
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!
    if (m.type !== 'user' || m.isMeta || m.isCompactSummary) continue
    if (
      Array.isArray(m.message.content) &&
      m.message.content.some(b => b.type === 'tool_result')
    ) {
      continue
    }
    count++
  }
  return count
}

/**
 * Counts post-compact prompts and memory recalls from the active session JSONL.
 */
export async function getTranscriptStats(
  transcriptPath: string = getTranscriptPath(),
): Promise<{ promptCount: number; memoryRecalls: number }> {
  let st
  try {
    st = await stat(transcriptPath)
  } catch {
    return { promptCount: 0, memoryRecalls: 0 }
  }
  if (st.size <= 0) {
    return { promptCount: 0, memoryRecalls: 0 }
  }
  const { buffer } = await readTranscriptForLoad(transcriptPath, st.size)
  const entries = parseJsonl<Entry>(buffer)
  const msgs: Message[] = []
  let memoryRecalls = 0

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    if (
      entry.type === 'user' ||
      entry.type === 'assistant' ||
      entry.type === 'system' ||
      entry.type === 'attachment'
    ) {
      msgs.push(entry as Message)
      if (
        entry.type === 'attachment' &&
        entry.attachment.type === 'relevant_memories' &&
        Array.isArray(entry.attachment.memories)
      ) {
        memoryRecalls += entry.attachment.memories.length
      }
    }
  }

  return {
    promptCount: countUserPromptsInMessages(msgs),
    memoryRecalls,
  }
}

/**
 * Formats enhanced PR attribution text incorporating prompt count and optional
 * contribution percentage.
 */
export async function getEnhancedPrAttribution(
  getAppState?: () => AppState,
  claudePercent?: number,
): Promise<string> {
  const base = getAttributionTexts()
  if (!base.pr) return ''
  const state = getAppState?.()
  const promptCount = state?.attribution.promptCount ?? 0
  if (claudePercent === undefined || promptCount <= 0) {
    return base.pr
  }
  const shortModel = sanitizeModelName(getMainLoopModel())
  return `${base.pr} (${claudePercent}% ${promptCount}-shotted by ${shortModel})`
}

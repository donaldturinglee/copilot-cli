/**
 * Deferred tool discovery (`ToolSearch`) mode resolution, model capability
 * checks, `tool_reference` extraction, and deferred-tool delta computation.
 */

import { TOOL_SEARCH_TOOL_NAME } from '../constants/tools.js'
import type { Tool } from '../types/forward.js'
import type { Message } from '../types/message.js'
import { getContextWindowForModel } from './context.js'

export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

const DEFAULT_AUTO_THRESHOLD_PERCENT = 10
const CHARS_PER_TOKEN = 4

/**
 * Resolves the active ToolSearch mode from `ENABLE_TOOL_SEARCH`:
 * - `'true'` / `'1'` -> `'tst'` (always defer marked tools)
 * - `'false'` / `'0'` -> `'standard'` (never defer; send all tool schemas)
 * - `'auto'` / `'auto:N'` / unset -> `'tst-auto'` (defer when deferred schemas
 *   exceed N% of the model context window)
 */
export function getToolSearchMode(): ToolSearchMode {
  const raw = process.env.ENABLE_TOOL_SEARCH?.trim().toLowerCase()
  if (!raw || raw === 'auto' || raw.startsWith('auto:')) {
    return 'tst-auto'
  }
  if (raw === 'true' || raw === '1') {
    return 'tst'
  }
  if (raw === 'false' || raw === '0') {
    return 'standard'
  }
  return 'tst-auto'
}

/**
 * Returns the character threshold above which `'tst-auto'` activates deferred
 * tool loading (default: 10% of the model context window in characters, or
 * custom percentage from `ENABLE_TOOL_SEARCH=auto:N`).
 */
export function getAutoToolSearchCharThreshold(model = ''): number {
  const raw = process.env.ENABLE_TOOL_SEARCH?.trim().toLowerCase() ?? ''
  let percent = DEFAULT_AUTO_THRESHOLD_PERCENT
  if (raw.startsWith('auto:')) {
    const parsed = Number.parseFloat(raw.slice('auto:'.length))
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 100) {
      percent = parsed
    }
  }
  const contextTokens = model ? getContextWindowForModel(model) : 200_000
  return Math.floor((contextTokens * CHARS_PER_TOKEN * percent) / 100)
}

/**
 * Returns true if the target model supports Anthropic `defer_loading` and
 * `tool_reference` blocks (Claude 3.7 / 4.x Sonnet/Opus/Haiku families).
 */
export function modelSupportsToolReference(model: string): boolean {
  const lower = model.toLowerCase()
  if (!lower) return true
  if (lower.includes('claude-3-5') || lower.includes('claude-3.5')) {
    return false
  }
  if (lower.includes('claude-3-opus') || lower.includes('claude-3-haiku') || lower.includes('claude-3-sonnet')) {
    return false
  }
  return true
}

/**
 * Fast check for whether ToolSearch could be active for `model`.
 */
export function isToolSearchEnabledOptimistic(model: string): boolean {
  return getToolSearchMode() !== 'standard' && modelSupportsToolReference(model)
}

/**
 * Returns true if the `ToolSearch` tool is present in `tools`.
 */
export function isToolSearchToolAvailable(tools: readonly Tool[]): boolean {
  return tools.some(tool => tool.name === TOOL_SEARCH_TOOL_NAME)
}

/**
 * Determines whether deferred tool loading should be active for the current
 * request based on mode, model support, presence of `ToolSearch`, and deferred
 * tool schema volume.
 */
export function isToolSearchEnabled(
  model: string,
  tools: readonly Tool[],
  deferredCharsEstimate?: number,
): boolean {
  const mode = getToolSearchMode()
  if (mode === 'standard') {
    return false
  }
  if (!modelSupportsToolReference(model)) {
    return false
  }
  if (!isToolSearchToolAvailable(tools)) {
    return false
  }
  const deferredTools = tools.filter(
    t => t.shouldDefer === true && t.alwaysLoad !== true,
  )
  if (deferredTools.length === 0) {
    return false
  }
  if (mode === 'tst') {
    return true
  }
  const threshold = getAutoToolSearchCharThreshold(model)
  const estimate =
    deferredCharsEstimate ?? deferredTools.length * 1_500
  return estimate >= threshold
}

/**
 * Type guard for Anthropic `tool_reference` blocks emitted by `ToolSearch`.
 */
export function isToolReferenceBlock(
  block: unknown,
): block is { type: 'tool_reference'; tool_name: string } {
  return (
    Boolean(block) &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'tool_reference' &&
    typeof (block as { tool_name?: unknown }).tool_name === 'string'
  )
}

/**
 * Extracts all deferred tool names already discovered in conversation history
 * via `ToolSearch` `tool_reference` blocks or prior `tool_use` calls.
 */
export function extractDiscoveredToolNames(
  messages: readonly Message[],
): Set<string> {
  const discovered = new Set<string>()
  for (const msg of messages) {
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        const rawBlock: unknown = block
        if (isToolReferenceBlock(rawBlock)) {
          discovered.add(rawBlock.tool_name)
        } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const nested of block.content) {
            const rawNested: unknown = nested
            if (isToolReferenceBlock(rawNested)) {
              discovered.add(rawNested.tool_name)
            }
          }
        }
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          discovered.add(block.name)
        }
      }
    }
  }
  return discovered
}

/**
 * Returns the names of deferred tools available in `tools` that have not yet
 * been discovered/announced in `alreadyAnnounced`.
 */
export function getDeferredToolsDelta(
  tools: readonly Tool[],
  alreadyAnnounced: ReadonlySet<string>,
): string[] {
  const delta: string[] = []
  for (const tool of tools) {
    if (
      tool.shouldDefer === true &&
      tool.alwaysLoad !== true &&
      !alreadyAnnounced.has(tool.name)
    ) {
      delta.push(tool.name)
    }
  }
  return delta
}

/**
 * Session-cached vs. explicitly uncached dynamic system prompt sections,
 * preserving Prompt Cache stability across turns until `/clear` or `/compact`.
 */

import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from '../bootstrap/state.js'

export type ComputeSectionFn = () => string | null | Promise<string | null>

export interface SystemPromptSection {
  name: string
  compute: ComputeSectionFn
  cacheBreak: boolean
}

/**
 * Declares a dynamic system prompt section memoized for the session (caches
 * both string and `null` results so prefix stability is guaranteed).
 */
export function systemPromptSection(
  name: string,
  compute: ComputeSectionFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

/**
 * Declares an uncached dynamic section recomputed every turn (use sparingly —
 * changes invalidate downstream Prompt Cache blocks).
 */
export function dangerousUncachedSystemPromptSection(
  name: string,
  compute: ComputeSectionFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

/**
 * Resolves all declared dynamic sections in parallel, reusing session-cached
 * results for non-cache-breaking sections.
 */
export async function resolveSystemPromptSections(
  sections: readonly SystemPromptSection[],
): Promise<Array<string | null>> {
  const cache = getSystemPromptSectionCache()
  return Promise.all(
    sections.map(async section => {
      if (!section.cacheBreak && cache.has(section.name)) {
        return cache.get(section.name) ?? null
      }
      const value = await section.compute()
      setSystemPromptSectionCacheEntry(section.name, value)
      return value
    }),
  )
}

/**
 * Clears cached dynamic system prompt sections AND resets sticky beta latches
 * (invoked on `/clear`, `/compact`, and session reset).
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}

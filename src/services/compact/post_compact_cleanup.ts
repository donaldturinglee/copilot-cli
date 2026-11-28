/**
 * Post-compaction cache & state cleanup (`runPostCompactCleanup`):
 * Resets microcompact state, system prompt sections & sticky beta latches,
 * classifier approvals, and session message cache while protecting main-thread
 * global caches during subagent (`agent:*`) compactions.
 */

import type { QuerySource } from '../../constants/query_source.js'
import { clearSystemPromptSections } from '../../constants/system_prompt_sections.js'
import { clearContextCaches } from '../../context.js'
import { resetGetMemoryFilesCache } from '../../utilities/claudemd.js'
import { clearClassifierApprovals } from '../../utilities/classifier_approvals.js'
import { clearSessionMessagesCache } from '../../utilities/session_storage.js'
import { resetMicrocompactState } from './micro_compact.js'

/**
 * Cleans up cached prompt sections, beta latches, microcompact state, and
 * (for main-thread compactions) user context & memory file caches.
 * Deliberately preserves invoked skills so post-compact skill restoration
 * keeps working cleanly.
 */
export function runPostCompactCleanup(querySource?: QuerySource): void {
  const isMainThreadCompact =
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'

  resetMicrocompactState()
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSessionMessagesCache()

  if (isMainThreadCompact) {
    clearContextCaches()
    resetGetMemoryFilesCache('compact')
  }
}

/**
 * Team memory tool-input classifiers and UI collapse-summary label formatters.
 */

import { FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME } from '../constants/tools.js'
import { isTeamMemFile } from '../memdir/team_mem_paths.js'

export { isTeamMemFile }

/**
 * Returns `true` when a search tool's `path` targets the team memory directory.
 */
export function isTeamMemorySearch(toolInput: unknown): boolean {
  if (!toolInput || typeof toolInput !== 'object') {
    return false
  }
  const pathVal = (toolInput as { path?: unknown }).path
  return typeof pathVal === 'string' && isTeamMemFile(pathVal)
}

/**
 * Returns `true` when an `Edit` or `Write` tool call targets a team memory file.
 */
export function isTeamMemoryWriteOrEdit(
  toolName: string,
  toolInput: unknown,
): boolean {
  if (toolName !== FILE_WRITE_TOOL_NAME && toolName !== FILE_EDIT_TOOL_NAME) {
    return false
  }
  if (!toolInput || typeof toolInput !== 'object') {
    return false
  }
  const rec = toolInput as { file_path?: unknown; path?: unknown }
  const target =
    typeof rec.file_path === 'string'
      ? rec.file_path
      : typeof rec.path === 'string'
        ? rec.path
        : null
  return target !== null && isTeamMemFile(target)
}

export interface TeamMemoryOperationCounts {
  teamMemoryReadCount?: number
  teamMemorySearchCount?: number
  teamMemoryWriteCount?: number
}

/**
 * Appends human-readable team memory phrases (`Recalled N team memories`, etc.)
 * to a collapsed read/search group's summary parts array.
 */
export function appendTeamMemorySummaryParts(
  counts: TeamMemoryOperationCounts,
  isActive: boolean,
  parts: string[],
): void {
  const reads = counts.teamMemoryReadCount ?? 0
  const searches = counts.teamMemorySearchCount ?? 0
  const writes = counts.teamMemoryWriteCount ?? 0

  if (reads > 0) {
    const verb = isActive ? 'Recalling' : 'Recalled'
    parts.push(`${verb} ${reads} team ${reads === 1 ? 'memory' : 'memories'}`)
  }
  if (searches > 0) {
    parts.push(
      isActive ? 'Searching team memories' : 'Searched team memories',
    )
  }
  if (writes > 0) {
    const verb = isActive ? 'Writing' : 'Wrote'
    parts.push(`${verb} ${writes} team ${writes === 1 ? 'memory' : 'memories'}`)
  }
}

/**
 * Internal session file-access tracking callback hook (`PostToolUse` on
 * `Read`/`Edit`/`Write`/`NotebookEdit`) for audit & rewind tracking.
 */

import type { HookCallback, HookInput, HookJSONOutput } from '../types/hooks.js'

export interface SessionFileAccessEntry {
  toolName: string
  filePath: string
  timestamp: number
}

const accessedFiles: SessionFileAccessEntry[] = []

export function getSessionAccessedFiles(): readonly SessionFileAccessEntry[] {
  return accessedFiles
}

export function clearSessionAccessedFiles(): void {
  accessedFiles.length = 0
}

export function createSessionFileAccessHook(): HookCallback {
  return {
    type: 'callback',
    internal: true,
    async callback(input: HookInput): Promise<HookJSONOutput> {
      if (input.hook_event_name === 'PostToolUse') {
        const pathVal =
          typeof input.tool_input.file_path === 'string'
            ? input.tool_input.file_path
            : typeof input.tool_input.notebook_path === 'string'
              ? input.tool_input.notebook_path
              : undefined
        if (pathVal) {
          accessedFiles.push({
            toolName: input.tool_name,
            filePath: pathVal,
            timestamp: Date.now(),
          })
        }
      }
      return {}
    },
  }
}

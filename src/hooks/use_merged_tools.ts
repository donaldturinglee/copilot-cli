/**
 * Merges built-in tools with `AppState.mcp.tools` via cache-stable
 * `assembleToolPool`.
 */

import { useMemo } from 'react'
import { useAppState } from '../state/app_state.js'
import type { AnyTool } from '../tool.js'
import { assembleToolPool } from '../tools.js'

/**
 * Returns the active merged tool pool reacting to permission rules and live MCP
 * tool updates.
 */
export function useMergedTools(): AnyTool[] {
  const permCtx = useAppState(s => s.toolPermissionContext)
  const mcpTools = useAppState(s => s.mcp.tools)

  return useMemo(
    () =>
      assembleToolPool(permCtx, mcpTools as unknown as readonly AnyTool[]),
    [mcpTools, permCtx],
  )
}

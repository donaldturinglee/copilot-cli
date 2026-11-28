/**
 * Merges base/skill commands with dynamic `AppState.plugins.commands` and
 * `AppState.mcp.commands` without duplicates.
 */

import { useMemo } from 'react'
import { useAppState } from '../state/app_state.js'
import type { Command } from '../types/command.js'

/**
 * Returns a deduplicated list combining `baseCommands`, `plugins.commands`, and
 * `mcp.commands`.
 */
export function useMergedCommands(baseCommands: readonly Command[]): Command[] {
  const pluginCommands = useAppState(s => s.plugins.commands)
  const mcpCommands = useAppState(s => s.mcp.commands)

  return useMemo(() => {
    const seen = new Set<string>()
    const merged: Command[] = []
    for (const cmd of [...baseCommands, ...pluginCommands, ...mcpCommands]) {
      const key = cmd.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(cmd)
    }
    return merged
  }, [baseCommands, mcpCommands, pluginCommands])
}

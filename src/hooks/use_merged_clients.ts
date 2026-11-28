/**
 * Deduplicates initial and dynamic MCP server connections by `name`.
 */

import uniqBy from 'lodash-es/uniqBy.js'
import { useMemo } from 'react'
import { useAppState } from '../state/app_state.js'
import type { McpServerConnection } from '../types/forward.js'

/**
 * Returns deduplicated `McpServerConnection[]` from `AppState.mcp.clients` and
 * optional initial connections.
 */
export function useMergedClients(
  initialClients: readonly McpServerConnection[] = [],
): McpServerConnection[] {
  const dynamicClients = useAppState(s => s.mcp.clients)
  return useMemo(
    () => uniqBy([...dynamicClients, ...initialClients], c => c.name),
    [dynamicClients, initialClients],
  )
}

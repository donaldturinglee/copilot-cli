/**
 * Displays `.mcp.json` / environment expansion warnings inside MCP settings dialogs.
 */

import React from 'react'
import { FIGURES } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import type { McpConfigWarning } from '../../services/mcp/types.js'
import { ThemedText } from '../design_system/themed_text.js'

export interface McpParsingWarningsProps {
  warnings: readonly McpConfigWarning[]
}

/**
 * Renders non-fatal configuration warnings for MCP servers.
 */
export function McpParsingWarnings({
  warnings,
}: McpParsingWarningsProps): React.ReactNode {
  if (warnings.length === 0) {
    return null
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      {warnings.map((warning, idx) => (
        <ThemedText key={`${warning.serverName ?? 'mcp'}-${idx}`} color="warning">
          {FIGURES.warning} {warning.message}
        </ThemedText>
      ))}
    </Box>
  )
}

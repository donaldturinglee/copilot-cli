/**
 * Displays negotiated MCP `ServerCapabilities` (`tools`, `resources`, `prompts`,
 * `logging`, `claude/channel`) inside MCP server detail menus.
 */

import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'
import React from 'react'
import { Box } from '../../ink/components/box.js'
import { ThemedText } from '../design_system/themed_text.js'

export interface CapabilitiesSectionProps {
  capabilities?: ServerCapabilities
  toolsCount?: number
  resourcesCount?: number
  promptsCount?: number
}

/**
 * Renders a compact summary of advertised MCP server capabilities.
 */
export function CapabilitiesSection({
  capabilities,
  toolsCount = 0,
  resourcesCount = 0,
  promptsCount = 0,
}: CapabilitiesSectionProps): React.ReactNode {
  if (!capabilities) {
    return (
      <ThemedText dimColor>Capabilities: unavailable (not connected)</ThemedText>
    )
  }

  const badges: string[] = []
  if (capabilities.tools || toolsCount > 0) {
    badges.push(`tools (${toolsCount})`)
  }
  if (capabilities.resources || resourcesCount > 0) {
    badges.push(`resources (${resourcesCount})`)
  }
  if (capabilities.prompts || promptsCount > 0) {
    badges.push(`prompts (${promptsCount})`)
  }
  if (capabilities.logging) {
    badges.push('logging')
  }
  const experimental = capabilities.experimental as
    | Record<string, unknown>
    | undefined
  if (experimental && 'claude/channel' in experimental) {
    badges.push('channel')
  }

  return (
    <Box flexDirection="row" gap={1}>
      <ThemedText bold>Capabilities:</ThemedText>
      <ThemedText dimColor={badges.length === 0}>
        {badges.length > 0 ? badges.join(' · ') : 'none'}
      </ThemedText>
    </Box>
  )
}

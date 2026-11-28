/**
 * Detailed schema and annotation inspector for a single MCP tool.
 */

import React, { useEffect, useState } from 'react'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { Box } from '../../ink/components/box.js'
import { useInput } from '../../ink/hooks/use_input.js'
import { getMcpDisplayName } from '../../services/mcp/mcp_string_utils.js'
import type { AnyTool } from '../../tool.js'
import type { Tool } from '../../types/forward.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import type { ServerInfo } from './types.js'

export interface McpToolDetailViewProps {
  tool: Tool
  server: ServerInfo
  onBack: () => void
}

/**
 * Displays an MCP tool's full qualified name, annotations, description, and
 * JSON Schema parameters.
 */
export function MCPToolDetailView({
  tool,
  server,
  onBack,
}: McpToolDetailViewProps): React.ReactNode {
  const anyTool = tool as unknown as AnyTool
  const [description, setDescription] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    if (typeof anyTool.description === 'function') {
      void anyTool
        .description(
          {},
          {
            getToolPermissionContext: async () => getEmptyToolPermissionContext(),
            tools: [],
            agents: [],
          },
        )
        .then(desc => {
          if (!cancelled) {
            setDescription(desc)
          }
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [anyTool])

  useInput((_ch, key) => {
    if (key.escape || key.return) {
      onBack()
    }
  })

  const shortName = getMcpDisplayName(tool.name, server.name)
  const properties =
    anyTool.inputJSONSchema?.properties &&
    typeof anyTool.inputJSONSchema.properties === 'object'
      ? Object.entries(anyTool.inputJSONSchema.properties)
      : []
  const required = new Set(anyTool.inputJSONSchema?.required ?? [])

  return (
    <Dialog
      title={shortName}
      subtitle={`${server.name} · ${tool.name}`}
      onCancel={onBack}
    >
      <Box flexDirection="column" gap={1}>
        {description ? <ThemedText>{description}</ThemedText> : null}
        <Box flexDirection="column">
          <ThemedText bold>Parameters ({properties.length}):</ThemedText>
          {properties.length === 0 ? (
            <ThemedText dimColor>None</ThemedText>
          ) : (
            properties.map(([paramName, rawProp]) => {
              const prop =
                rawProp && typeof rawProp === 'object'
                  ? (rawProp as { type?: unknown; description?: unknown })
                  : {}
              const typeLabel =
                typeof prop.type === 'string' ? prop.type : 'unknown'
              const isReq = required.has(paramName)
              return (
                <Box key={paramName} flexDirection="row" gap={1}>
                  <ThemedText bold>{paramName}</ThemedText>
                  <ThemedText dimColor>
                    ({typeLabel}
                    {isReq ? ', required' : ''})
                  </ThemedText>
                  {typeof prop.description === 'string' ? (
                    <ThemedText dimColor>— {prop.description}</ThemedText>
                  ) : null}
                </Box>
              )
            })
          )}
        </Box>
      </Box>
    </Dialog>
  )
}

/**
 * `ListMcpResourcesTool`: lists resources across connected MCP servers that
 * advertise `capabilities.resources`.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { LIST_MCP_RESOURCES_TOOL_NAME } from '../../constants/tools.js'
import type { ConnectedMcpServer, ServerResource } from '../../services/mcp/types.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import {
  LIST_MCP_RESOURCES_DESCRIPTION,
  LIST_MCP_RESOURCES_PROMPT,
} from './prompt.js'

const ListMcpResourcesInputSchema = z.object({
  server: z
    .string()
    .optional()
    .describe('Optional MCP server name to filter resources by'),
})

export type ListMcpResourcesInput = z.infer<typeof ListMcpResourcesInputSchema>
export type ListMcpResourcesOutput = ServerResource[]

export const ListMcpResourcesTool = buildTool<
  ListMcpResourcesInput,
  ListMcpResourcesOutput
>({
  name: LIST_MCP_RESOURCES_TOOL_NAME,
  searchHint: 'list resources exposed by connected MCP servers',
  shouldDefer: true,
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  inputSchema: ListMcpResourcesInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,

  userFacingName(input) {
    return input?.server
      ? `ListMcpResources(${input.server})`
      : 'ListMcpResources'
  },

  async description() {
    return LIST_MCP_RESOURCES_DESCRIPTION
  },

  async prompt() {
    return LIST_MCP_RESOURCES_PROMPT
  },

  async call(input, context: ToolUseContext) {
    const rawClients =
      context.options?.mcpClients ??
      context.getAppState?.().mcp.clients ??
      []
    const connected = rawClients.filter(
      (c): c is ConnectedMcpServer =>
        Boolean(c) &&
        typeof c === 'object' &&
        (c as { type?: unknown }).type === 'connected' &&
        (!input.server || (c as { name?: unknown }).name === input.server),
    )

    const results: ServerResource[] = []
    if (connected.length > 0) {
      const { fetchResourcesForClient } = await import(
        '../../services/mcp/client.js'
      )
      for (const srv of connected) {
        if (!srv.capabilities?.resources) {
          continue
        }
        const items = await fetchResourcesForClient(srv)
        results.push(...items)
      }
    }

    return { data: results }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: JSON.stringify(output, null, 2),
    }
  },
})

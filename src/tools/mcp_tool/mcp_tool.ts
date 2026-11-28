/**
 * Dynamic `MCPTool` factory wrapping each MCP server tool in a strongly-typed
 * `Tool` contract with annotation mapping (`readOnlyHint`, `destructiveHint`,
 * `openWorldHint`), `-32001` session-expiry auto-reconnect, media/binary block
 * conversion, and oversized JSON schema-aware disk spilling.
 */

import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type { Tool as SdkMcpTool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { MCP_TOOL_NAME } from '../../constants/tools.js'
import {
  callMcpToolWithUrlElicitationRetry,
  getConnectedMcpServer,
  McpSessionExpiredError,
  reconnectMcpServerImpl,
  transformMcpContentBlocks,
} from '../../services/mcp/client.js'
import { getToolNameForPermissionCheck } from '../../services/mcp/mcp_string_utils.js'
import type { ConnectedMcpServer } from '../../services/mcp/types.js'
import {
  asAnyTool,
  buildTool,
  type AnyTool,
  type ToolInputJsonSchema,
  type ToolUseContext,
} from '../../tool.js'
import type { McpProgress } from '../../types/tools.js'
import { openBrowser } from '../../utilities/browser.js'
import { saveMcpOutput } from '../../utilities/mcp_output_storage.js'
import { getMaxMcpOutputChars } from '../../utilities/mcp_validation.js'
import { classifyMcpToolForCollapse } from './classify_for_collapse.js'
import { MCP_TOOL_DESCRIPTION, MCP_TOOL_PROMPT } from './prompt.js'
import {
  renderMcpToolProgressMessage,
  renderMcpToolResultMessage,
  renderMcpToolUseMessage,
} from './ui.js'

export type McpToolInput = Record<string, unknown>

export interface McpToolOutput {
  content: ContentBlockParam[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

const GenericMcpInputSchema = z.record(z.string(), z.unknown())

/**
 * Base template `MCPTool` definition.
 */
export const MCPTool = buildTool<McpToolInput, McpToolOutput, McpProgress>({
  name: MCP_TOOL_NAME,
  maxResultSizeChars: Infinity,
  isMcp: true,
  inputSchema: GenericMcpInputSchema,
  async description() {
    return MCP_TOOL_DESCRIPTION
  },
  async prompt() {
    return MCP_TOOL_PROMPT
  },
  async call() {
    throw new Error('Base MCPTool template cannot be invoked directly')
  },
  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      is_error: output.isError,
      content: output.content as ToolResultBlockParam['content'],
    }
  },
})

/**
 * Specializes `MCPTool` for a discovered `(server, sdkTool)` pair.
 */
export function createMcpToolInstance(params: {
  server: ConnectedMcpServer
  sdkTool: SdkMcpTool
  qualifiedName: string
  inputJsonSchema: ToolInputJsonSchema
  maxResultSizeChars: number
  genericInputSchema: z.ZodType<McpToolInput>
}): AnyTool {
  const { server, sdkTool, qualifiedName, inputJsonSchema } = params
  const readOnly = Boolean(sdkTool.annotations?.readOnlyHint)
  const destructive = Boolean(sdkTool.annotations?.destructiveHint)
  const openWorld = sdkTool.annotations?.openWorldHint ?? true
  const collapseCategory = classifyMcpToolForCollapse(server.name, sdkTool.name)
  const displayTitle = sdkTool.annotations?.title ?? sdkTool.name

  const toolInstance = buildTool<McpToolInput, McpToolOutput, McpProgress>({
    name: qualifiedName,
    isMcp: true,
    mcpInfo: { serverName: server.name, toolName: sdkTool.name },
    searchHint: `${server.name} ${displayTitle} ${sdkTool.description ?? ''}`.trim(),
    shouldDefer: true,
    maxResultSizeChars: Infinity,
    inputSchema: params.genericInputSchema,
    inputJSONSchema: inputJsonSchema,

    isReadOnly: () => readOnly,
    isConcurrencySafe: () => readOnly,
    isDestructive: () => destructive,
    isOpenWorld: () => openWorld,
    ...(collapseCategory
      ? {
          isSearchOrReadCommand: () => ({
            isSearch: collapseCategory.kind === 'search',
            isRead: collapseCategory.kind === 'read',
          }),
        }
      : {}),

    userFacingName() {
      return `${server.name} - ${displayTitle} (MCP)`
    },

    toAutoClassifierInput(input) {
      return `${qualifiedName}(${JSON.stringify(input).slice(0, 500)})`
    },

    async description() {
      return (
        sdkTool.description ??
        `MCP tool "${sdkTool.name}" from server "${server.name}"`
      )
    },

    async prompt() {
      return (
        sdkTool.description ??
        `MCP tool "${sdkTool.name}" provided by "${server.name}".`
      )
    },

    async checkPermissions() {
      const ruleName = getToolNameForPermissionCheck({
        name: qualifiedName,
        mcpInfo: { serverName: server.name, toolName: sdkTool.name },
      })
      return {
        behavior: 'passthrough',
        message: `Allow MCP tool ${server.name}:${sdkTool.name}?`,
        suggestions: [
          {
            type: 'addRules',
            destination: 'localSettings',
            behavior: 'allow',
            rules: [{ toolName: ruleName }],
          },
        ],
      }
    },

    async call(args, context: ToolUseContext, _canUseTool, parentMsg, onProgress) {
      const toolUseId =
        parentMsg &&
        typeof parentMsg === 'object' &&
        'id' in parentMsg &&
        typeof (parentMsg as { id?: unknown }).id === 'string'
          ? (parentMsg as { id: string }).id
          : `${qualifiedName}_${Date.now()}`

      const startMs = Date.now()
      onProgress?.({
        toolUseId,
        data: {
          type: 'mcp_progress',
          status: 'started',
          serverName: server.name,
          toolName: sdkTool.name,
        },
      })

      let activeServer =
        getConnectedMcpServer(server.name, context.options?.mcpClients) ?? server

      let callResult
      for (let sessionAttempt = 0; sessionAttempt < 2; sessionAttempt++) {
        try {
          callResult = await callMcpToolWithUrlElicitationRetry({
            server: activeServer,
            toolName: sdkTool.name,
            args,
            signal: context.abortController.signal,
            onProgress: prog => {
              onProgress?.({
                toolUseId,
                data: {
                  type: 'mcp_progress',
                  status: 'progress',
                  serverName: server.name,
                  toolName: sdkTool.name,
                  elapsedTimeMs: Date.now() - startMs,
                  progress: prog.progress,
                  total: prog.total,
                  progressMessage: prog.message,
                },
              })
            },
            onUrlElicitation: async url => {
              await openBrowser(url)
              return true
            },
          })
          break
        } catch (error) {
          if (error instanceof McpSessionExpiredError && sessionAttempt === 0) {
            const reconnected = await reconnectMcpServerImpl(
              server.name,
              server.config,
            )
            if (reconnected.client.type === 'connected') {
              activeServer = reconnected.client
              continue
            }
          }
          onProgress?.({
            toolUseId,
            data: {
              type: 'mcp_progress',
              status: 'failed',
              serverName: server.name,
              toolName: sdkTool.name,
              elapsedTimeMs: Date.now() - startMs,
            },
          })
          throw error
        }
      }

      if (!callResult) {
        throw new Error(`MCP tool "${qualifiedName}" returned no result`)
      }

      let content = await transformMcpContentBlocks(callResult.content ?? [])
      const structured =
        callResult.structuredContent &&
        typeof callResult.structuredContent === 'object'
          ? (callResult.structuredContent as Record<string, unknown>)
          : undefined

      if (content.length === 0 && structured) {
        content = [{ type: 'text', text: JSON.stringify(structured, null, 2) }]
      }

      // Spill oversized pure-text MCP results to disk with compact JSON schema
      const maxChars = getMaxMcpOutputChars()
      const hasMedia = content.some(b => b.type !== 'text')
      if (!hasMedia && !callResult.isError) {
        const combinedText = content
          .map(b => (b.type === 'text' ? b.text : ''))
          .join('\n')
        if (combinedText.length > maxChars) {
          const spilled = saveMcpOutput(combinedText, toolUseId)
          content = [{ type: 'text', text: spilled.formattedMessage }]
        }
      }

      onProgress?.({
        toolUseId,
        data: {
          type: 'mcp_progress',
          status: 'completed',
          serverName: server.name,
          toolName: sdkTool.name,
          elapsedTimeMs: Date.now() - startMs,
        },
      })

      const metaObj =
        callResult._meta && typeof callResult._meta === 'object'
          ? (callResult._meta as Record<string, unknown>)
          : undefined

      return {
        data: {
          content,
          isError: Boolean(callResult.isError),
          structuredContent: structured,
        },
        mcpMeta: {
          ...(metaObj ? { _meta: metaObj } : {}),
          ...(structured ? { structuredContent: structured } : {}),
        },
      }
    },

    mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        ...(output.isError ? { is_error: true } : {}),
        content: (output.content.length > 0
          ? output.content
          : [{ type: 'text', text: '(empty MCP result)' }]) as ToolResultBlockParam['content'],
      }
    },

    renderToolUseMessage: renderMcpToolUseMessage,
    renderToolUseProgressMessage: renderMcpToolProgressMessage,
    renderToolResultMessage: renderMcpToolResultMessage,
  })

  return asAnyTool(toolInstance)
}

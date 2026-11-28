/**
 * `copilot mcp serve` MCP Server entrypoint exposing Copilot CLI's built-in
 * tools (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, etc.) over stdio or
 * custom `Transport` (such as `InProcessTransport` in self-tests).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { setCwdState } from '../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../state/app_state_store.js'
import { onChangeAppState } from '../state/on_change_app_state.js'
import { createStore } from '../state/store.js'
import { findToolByName } from '../tool.js'
import { getTools } from '../tools.js'
import { hasPermissionsToUseTool } from '../utilities/permissions/permissions.js'
import { createFileStateCache } from '../utilities/query_helpers.js'
import { zodToJsonSchema } from '../utilities/zod_to_json_schema.js'

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

/**
 * Creates and wires an MCP `Server` instance exposing Copilot CLI's built-in
 * tools without starting stdio transport yet (reusable with `InProcessTransport`).
 */
export function createCopilotMcpServer(options?: {
  directory?: string
  verbose?: boolean
}): Server {
  if (options?.directory) {
    setCwdState(options.directory)
  }

  const store = createStore<AppState>(getDefaultAppState(), onChangeAppState)
  const readFileState = createFileStateCache()
  const server = new Server(
    { name: 'copilot-cli', version: getMacroVersion() },
    { capabilities: { tools: {} } },
  )

  const getAvailableTools = () => getTools(store.getState().toolPermissionContext)

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = getAvailableTools()
    const toolEntries = await Promise.all(
      tools.map(async tool => {
        const description = await tool.prompt({
          getToolPermissionContext: async () =>
            store.getState().toolPermissionContext,
          tools,
          agents: [],
        })
        const inputSchema =
          tool.inputJSONSchema ??
          (zodToJsonSchema(tool.inputSchema) as {
            type: 'object'
            properties?: Record<string, unknown>
            required?: string[]
          })
        return {
          name: tool.name,
          description,
          inputSchema: {
            ...inputSchema,
            type: 'object' as const,
          },
        }
      }),
    )
    return { tools: toolEntries }
  })

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const toolName = request.params.name
    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>
    const tools = getAvailableTools()
    const tool = findToolByName(tools, toolName)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      }
    }

    const parsed = tool.inputSchema.safeParse(rawArgs)
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
          },
        ],
      }
    }

    const validatedArgs = parsed.data as Record<string, unknown>
    const context = {
      abortController: new AbortController(),
      messages: [],
      readFileState,
      getAppState: () => store.getState(),
      setAppState: store.setState,
      options: {
        tools,
        verbose: Boolean(options?.verbose),
        isNonInteractiveSession: true,
      },
    }

    if (tool.validateInput) {
      const validation = await tool.validateInput(validatedArgs, context)
      if (!validation.result) {
        return {
          isError: true,
          content: [{ type: 'text', text: validation.message }],
        }
      }
    }

    const permDecision = await hasPermissionsToUseTool(
      tool,
      validatedArgs,
      context,
      undefined,
      `mcp_serve_${Date.now()}`,
    )
    if (permDecision.behavior === 'deny') {
      return {
        isError: true,
        content: [{ type: 'text', text: permDecision.message }],
      }
    }

    try {
      const effectiveArgs =
        permDecision.behavior === 'allow' && permDecision.updatedInput
          ? permDecision.updatedInput
          : validatedArgs
      const result = await tool.call(
        effectiveArgs,
        context,
        async () => ({ behavior: 'allow', updatedInput: effectiveArgs }),
        undefined,
      )
      const mapped = tool.mapToolResultToToolResultBlockParam(
        result.data,
        `mcp_serve_${Date.now()}`,
      )
      const contentBlocks =
        typeof mapped.content === 'string'
          ? [{ type: 'text' as const, text: mapped.content }]
          : Array.isArray(mapped.content)
            ? mapped.content.map(b =>
                b.type === 'text'
                  ? { type: 'text' as const, text: b.text }
                  : { type: 'text' as const, text: JSON.stringify(b) },
              )
            : [{ type: 'text' as const, text: String(mapped.content ?? '') }]

      return {
        isError: Boolean(mapped.is_error),
        content: contentBlocks,
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      }
    }
  })

  return server
}

/**
 * Starts the Copilot CLI MCP server over `transport` (defaults to
 * `StdioServerTransport`).
 */
export async function startMcpServer(
  directory: string,
  _debug?: boolean,
  verbose?: boolean,
  transport?: Transport,
): Promise<Server> {
  const server = createCopilotMcpServer({ directory, verbose })
  await server.connect(transport ?? new StdioServerTransport())
  return server
}

export const startMCPServer = startMcpServer

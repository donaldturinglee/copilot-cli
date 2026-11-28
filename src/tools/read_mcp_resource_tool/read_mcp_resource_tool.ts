/**
 * `ReadMcpResourceTool`: reads text, image, or binary blob contents of a
 * specific `uri` from a connected MCP server.
 */

import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { READ_MCP_RESOURCE_TOOL_NAME } from '../../constants/tools.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utilities/image_resizer.js'
import type { SupportedImageMediaType } from '../../utilities/image_validation.js'
import { persistBinaryContent } from '../../utilities/tool_result_storage.js'
import {
  READ_MCP_RESOURCE_DESCRIPTION,
  READ_MCP_RESOURCE_PROMPT,
} from './prompt.js'

const ReadMcpResourceInputSchema = z.object({
  server: z.string().min(1).describe('Name of the connected MCP server'),
  uri: z.string().min(1).describe('Resource URI to read'),
})

export type ReadMcpResourceInput = z.infer<typeof ReadMcpResourceInputSchema>

export interface ReadMcpResourceOutputItem {
  uri: string
  mimeType?: string
  text?: string
  imageBase64?: string
  blobSavedTo?: string
  blobSize?: number
}

export interface ReadMcpResourceOutput {
  server: string
  uri: string
  contents: ReadMcpResourceOutputItem[]
}

export const ReadMcpResourceTool = buildTool<
  ReadMcpResourceInput,
  ReadMcpResourceOutput
>({
  name: READ_MCP_RESOURCE_TOOL_NAME,
  searchHint: 'read the contents of an MCP server resource URI',
  shouldDefer: true,
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  inputSchema: ReadMcpResourceInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,

  userFacingName(input) {
    return input?.server && input?.uri
      ? `ReadMcpResource(${input.server}:${input.uri})`
      : 'ReadMcpResource'
  },

  async description() {
    return READ_MCP_RESOURCE_DESCRIPTION
  },

  async prompt() {
    return READ_MCP_RESOURCE_PROMPT
  },

  async call(input, context: ToolUseContext) {
    const [{ getConnectedMcpServer }, { ReadResourceResultSchema }] =
      await Promise.all([
        import('../../services/mcp/client.js'),
        import('@modelcontextprotocol/sdk/types.js'),
      ])
    const connected = getConnectedMcpServer(
      input.server,
      context.options?.mcpClients ?? context.getAppState?.().mcp.clients,
    )
    if (!connected) {
      throw new Error(`MCP server "${input.server}" is not connected`)
    }

    const res = await connected.client.request(
      { method: 'resources/read', params: { uri: input.uri } },
      ReadResourceResultSchema,
      { signal: context.abortController.signal },
    )

    const items: ReadMcpResourceOutputItem[] = []
    for (const entry of res.contents ?? []) {
      if ('text' in entry && typeof entry.text === 'string') {
        items.push({
          uri: entry.uri,
          mimeType: entry.mimeType,
          text: entry.text,
        })
        continue
      }
      if ('blob' in entry && typeof entry.blob === 'string') {
        const mime = entry.mimeType ?? 'application/octet-stream'
        const buf = Buffer.from(entry.blob, 'base64')
        if (mime.startsWith('image/')) {
          const resized = await maybeResizeAndDownsampleImageBuffer(
            buf,
            mime as SupportedImageMediaType,
          )
          items.push({
            uri: entry.uri,
            mimeType: resized.mediaType,
            imageBase64: resized.base64,
          })
        } else {
          const saved = await persistBinaryContent(buf, mime, 'mcp_resource')
          items.push({
            uri: entry.uri,
            mimeType: mime,
            ...('filepath' in saved
              ? { blobSavedTo: saved.filepath, blobSize: saved.size }
              : { text: `Failed to persist binary blob: ${saved.error}` }),
          })
        }
      }
    }

    return {
      data: {
        server: input.server,
        uri: input.uri,
        contents: items,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    const blocks: ContentBlockParam[] = []
    for (const item of output.contents) {
      if (item.imageBase64 && item.mimeType) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: item.mimeType as SupportedImageMediaType,
            data: item.imageBase64,
          },
        })
      } else if (item.blobSavedTo) {
        blocks.push({
          type: 'text',
          text: `Binary resource ${item.uri} (${item.mimeType ?? 'binary'}, ${item.blobSize ?? 0} bytes) saved to: ${item.blobSavedTo}`,
        })
      } else {
        blocks.push({
          type: 'text',
          text: item.text ?? JSON.stringify(item),
        })
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: (blocks.length > 0
        ? blocks
        : [{ type: 'text', text: '(empty resource)' }]) as ToolResultBlockParam['content'],
    }
  },
})

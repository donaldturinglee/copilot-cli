/**
 * `WebSearchTool` (`WebSearch`):
 * Invokes Anthropic's server-side `web_search_20250305` tool via
 * `queryModelWithStreaming` + `extraToolSchemas`, streaming `WebSearchProgress`
 * updates and returning formatted search summaries and source links.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { WEB_SEARCH_TOOL_NAME } from '../../constants/tools.js'
import { queryModelWithStreaming } from '../../services/api/claude.js'
import { buildTool, type ToolCallProgress, type ToolUseContext } from '../../tool.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import type { WebSearchProgress } from '../../types/tools.js'
import { createUserMessage, getAssistantMessageText } from '../../utilities/messages.js'
import { getMainLoopModel } from '../../utilities/model/model.js'
import { asSystemPrompt } from '../../utilities/system_prompt_type.js'
import {
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_PROMPT,
} from './prompt.js'

const WebSearchInputSchema = z.object({
  query: z.string().min(2).describe('The search query to execute'),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe('Only include search results from these domains'),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe('Never include search results from these domains'),
})

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>

export interface WebSearchResultLink {
  title: string
  url: string
}

export interface WebSearchOutput {
  query: string
  results: Array<string | { tool_use_id: string; content: WebSearchResultLink[] }>
  durationSeconds: number
}

export const WebSearchTool = buildTool<
  WebSearchInput,
  WebSearchOutput,
  WebSearchProgress
>({
  name: WEB_SEARCH_TOOL_NAME,
  searchHint: 'search the web for current information and documentation',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: WebSearchInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  isOpenWorld: () => true,
  interruptBehavior: () => 'cancel',

  toAutoClassifierInput(input) {
    return input.query
  },

  userFacingName(input) {
    return input?.query ? `WebSearch(${input.query})` : WEB_SEARCH_TOOL_NAME
  },

  async description() {
    return WEB_SEARCH_TOOL_DESCRIPTION
  },

  async prompt() {
    return WEB_SEARCH_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()
    if (permCtx.mode === 'bypassPermissions') {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'mode', mode: 'bypassPermissions' },
      }
    }
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: { type: 'other', reason: 'Read-only web search' },
    }
  },

  async validateInput(input) {
    if (input.query.trim().length < 2) {
      return {
        result: false,
        message: 'Search query must be at least 2 characters long.',
        errorCode: 1,
      }
    }
    if (
      input.allowed_domains &&
      input.allowed_domains.length > 0 &&
      input.blocked_domains &&
      input.blocked_domains.length > 0
    ) {
      return {
        result: false,
        message:
          'Cannot specify both allowed_domains and blocked_domains at the same time.',
        errorCode: 2,
      }
    }
    return { result: true }
  },

  async call(
    input,
    context: ToolUseContext,
    _canUseTool,
    _parentMessage,
    onProgress?: ToolCallProgress<WebSearchProgress>,
  ) {
    const start = Date.now()
    const serverToolSchema: Record<string, unknown> = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 8,
      ...(input.allowed_domains?.length
        ? { allowed_domains: input.allowed_domains }
        : {}),
      ...(input.blocked_domains?.length
        ? { blocked_domains: input.blocked_domains }
        : {}),
    }

    onProgress?.({
      toolUseId: 'web_search',
      data: { type: 'query_update', query: input.query },
    })

    const model = context.options?.mainLoopModel ?? getMainLoopModel()
    const results: WebSearchOutput['results'] = []
    const textChunks: string[] = []

    for await (const event of queryModelWithStreaming({
      messages: [
        createUserMessage({
          content: `Perform a web search for the query: ${input.query}`,
        }),
      ],
      systemPrompt: asSystemPrompt([
        'You are a web search assistant. Perform the requested web search and summarize findings accurately with source links.',
      ]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: context.abortController.signal,
      options: {
        model,
        querySource: 'web_search_tool',
        enablePromptCaching: false,
        extraToolSchemas: [serverToolSchema],
      },
    })) {
      if (event.type !== 'assistant') continue
      for (const block of event.message.content) {
        const rec = block as unknown as Record<string, unknown>
        if (
          rec.type === 'web_search_tool_result' &&
          Array.isArray(rec.content)
        ) {
          const links: WebSearchResultLink[] = []
          for (const item of rec.content) {
            if (
              item &&
              typeof item === 'object' &&
              typeof (item as { url?: unknown }).url === 'string'
            ) {
              const typed = item as { title?: string; url: string }
              links.push({
                title: typed.title ?? typed.url,
                url: typed.url,
              })
            }
          }
          results.push({
            tool_use_id: String(rec.tool_use_id ?? 'web_search'),
            content: links,
          })
          onProgress?.({
            toolUseId: String(rec.tool_use_id ?? 'web_search'),
            data: {
              type: 'search_results_received',
              resultCount: links.length,
              query: input.query,
            },
          })
        }
      }
      const txt = getAssistantMessageText(event).trim()
      if (txt) {
        textChunks.push(txt)
      }
    }

    if (textChunks.length > 0) {
      results.push(textChunks.join('\n\n'))
    }

    return {
      data: {
        query: input.query,
        results,
        durationSeconds: Math.round((Date.now() - start) / 100) / 10,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    const parts: string[] = [`Web search results for query: "${output.query}"`]
    for (const entry of output.results) {
      if (typeof entry === 'string') {
        parts.push(entry)
      } else if (entry.content.length > 0) {
        const linkLines = entry.content.map(
          link => `- [${link.title}](${link.url})`,
        )
        parts.push(`Links:\n${linkLines.join('\n')}`)
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: parts.join('\n\n'),
    }
  },
})

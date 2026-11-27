/**
 * `ToolSearchTool` (`ToolSearch`):
 * Discovers deferred tools via direct `select:ToolA,ToolB` selection or
 * weighted keyword scoring (with `+required` terms) and returns Anthropic
 * `tool_reference` content blocks so deferred schemas load dynamically.
 */

import type {
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import {
  type AnyTool,
  buildTool,
  toolMatchesName,
  type ToolUseContext,
} from '../../tool.js'
import {
  DEFAULT_TOOL_SEARCH_MAX_RESULTS,
  MAX_TOOL_SEARCH_RESULTS,
  TOOL_SEARCH_TOOL_NAME,
} from './constants.js'
import {
  TOOL_SEARCH_TOOL_DESCRIPTION,
  TOOL_SEARCH_TOOL_PROMPT,
} from './prompt.js'

const ToolSearchInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Query to find deferred tools: either `select:ToolA,ToolB` for direct selection or space-separated keywords (prefix with `+` to require a term)',
    ),
  max_results: z
    .number()
    .int()
    .positive()
    .max(MAX_TOOL_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_TOOL_SEARCH_MAX_RESULTS)
    .describe('Maximum number of matching tools to return (default 5)'),
})

export type ToolSearchInput = z.infer<typeof ToolSearchInputSchema>

export interface ToolSearchOutput {
  matches: string[]
  query: string
  total_deferred_tools: number
}

function splitCamelAndSnake(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-/:.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function scoreTool(
  tool: AnyTool,
  requiredTerms: readonly string[],
  optionalTerms: readonly string[],
): number {
  const nameLower = tool.name.toLowerCase()
  const nameTokens = new Set(splitCamelAndSnake(tool.name))
  const aliasTokens = new Set(
    (tool.aliases ?? []).flatMap(a => splitCamelAndSnake(a)),
  )
  const hintLower = (tool.searchHint ?? '').toLowerCase()
  const hintTokens = new Set(splitCamelAndSnake(hintLower))

  const scoreTerm = (term: string): number => {
    let termScore = 0
    if (nameLower === term) {
      termScore += 100
    } else if (nameTokens.has(term) || aliasTokens.has(term)) {
      termScore += 40
    } else if (nameLower.includes(term)) {
      termScore += 20
    }

    if (hintTokens.has(term)) {
      termScore += 15
    } else if (hintLower.includes(term)) {
      termScore += 8
    }

    return termScore
  }

  let total = 0
  for (const req of requiredTerms) {
    const s = scoreTerm(req)
    if (s === 0) {
      return 0
    }
    total += s * 1.5
  }

  for (const opt of optionalTerms) {
    total += scoreTerm(opt)
  }

  return total
}

export const ToolSearchTool = buildTool<ToolSearchInput, ToolSearchOutput>({
  name: TOOL_SEARCH_TOOL_NAME,
  searchHint: 'search and load deferred tool schemas',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  alwaysLoad: true,
  inputSchema: ToolSearchInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel',

  toAutoClassifierInput(input) {
    return input.query
  },

  userFacingName(input) {
    return input?.query
      ? `ToolSearch(${input.query})`
      : TOOL_SEARCH_TOOL_NAME
  },

  async description() {
    return TOOL_SEARCH_TOOL_DESCRIPTION
  },

  async prompt() {
    return TOOL_SEARCH_TOOL_PROMPT
  },

  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },

  async call(input, context: ToolUseContext) {
    const allTools = context.options?.tools ?? []
    const deferredTools = allTools.filter(
      t => t.shouldDefer === true && t.alwaysLoad !== true,
    )
    const searchableTools =
      deferredTools.length > 0
        ? deferredTools
        : allTools.filter(t => t.name !== TOOL_SEARCH_TOOL_NAME)

    const maxResults = input.max_results ?? DEFAULT_TOOL_SEARCH_MAX_RESULTS
    const trimmed = input.query.trim()

    // 1. Direct selection: `select:ToolA,ToolB`
    if (trimmed.toLowerCase().startsWith('select:')) {
      const requested = trimmed
        .slice('select:'.length)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

      const matched: string[] = []
      const seen = new Set<string>()
      for (const reqName of requested) {
        const reqLower = reqName.toLowerCase()
        const found = searchableTools.find(
          t =>
            toolMatchesName(t, reqName) ||
            t.name.toLowerCase() === reqLower ||
            t.aliases?.some(a => a.toLowerCase() === reqLower),
        )
        if (found && !seen.has(found.name)) {
          seen.add(found.name)
          matched.push(found.name)
        }
      }

      return {
        data: {
          matches: matched.slice(0, maxResults),
          query: input.query,
          total_deferred_tools: deferredTools.length,
        },
      }
    }

    // 2. Weighted keyword search with optional `+required` terms
    const rawTerms = trimmed.split(/\s+/).filter(Boolean)
    const requiredTerms: string[] = []
    const optionalTerms: string[] = []
    for (const term of rawTerms) {
      if (term.startsWith('+') && term.length > 1) {
        requiredTerms.push(term.slice(1).toLowerCase())
      } else {
        optionalTerms.push(term.toLowerCase())
      }
    }

    const scored = searchableTools
      .map(tool => ({
        name: tool.name,
        score: scoreTool(tool, requiredTerms, optionalTerms),
      }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, maxResults)
      .map(entry => entry.name)

    return {
      data: {
        matches: scored,
        query: input.query,
        total_deferred_tools: deferredTools.length,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    if (output.matches.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `No matching deferred tools found for query: "${output.query}".`,
      }
    }

    const blocks: ContentBlockParam[] = output.matches.map(
      name =>
        ({
          type: 'tool_reference',
          tool_name: name,
        }) as unknown as ContentBlockParam,
    )

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: blocks as ToolResultBlockParam['content'],
    }
  },
})

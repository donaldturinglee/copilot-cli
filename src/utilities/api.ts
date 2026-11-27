/**
 * Prompt-cache system-prompt prefix splitting, context injection helpers
 * (`appendSystemContext` / `prependUserContext`), and cached tool schema
 * serialization (`toolToApiSchema`).
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../constants/prompts.js'
import { CLI_SYSPROMPT_PREFIXES } from '../constants/system.js'
import type { Tool } from '../types/forward.js'
import type { Message } from '../types/message.js'
import { getEmptyToolPermissionContext } from '../types/permissions.js'
import { shouldUseGlobalCacheScope } from './betas.js'
import { isEnvTruthy } from './env_utils.js'
import { createUserMessage } from './messages.js'
import { jsonStringify } from './slow_operations.js'
import type { SystemPrompt } from './system_prompt_type.js'
import {
  clearToolSchemaCache,
  getToolSchemaCache,
} from './tool_schema_cache.js'
import { zodToJsonSchema } from './zod_to_json_schema.js'
import type { ZodTypeAny } from 'zod/v4'

export { clearToolSchemaCache }

export type CacheScope = 'global' | 'org'

export interface SystemPromptBlock {
  text: string
  cacheScope: CacheScope | null
}

export interface ApiToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
  strict?: boolean
  eager_input_streaming?: boolean
  defer_loading?: boolean
  cache_control?: Record<string, unknown>
}

/**
 * Splits a finalized system prompt array into cache-scoped blocks:
 * - Attribution header (`x-anthropic-billing-header...`) -> `cacheScope: null`.
 * - Global cache mode (1P + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` + no non-deferred MCP tools):
 *   prefix (`null`), static pre-boundary (`'global'`), dynamic post-boundary (`null`).
 * - Fallback / 3P / MCP mode:
 *   prefix (`'org'`), joined remaining blocks (`'org'`).
 */
export function splitSysPromptPrefix(
  systemPrompt: SystemPrompt | readonly string[],
  options?: { skipGlobalCacheForSystemPrompt?: boolean },
): SystemPromptBlock[] {
  const blocks: SystemPromptBlock[] = []
  const remaining = [...systemPrompt].filter(Boolean)
  if (remaining.length === 0) {
    return blocks
  }

  // Extract attribution header if first block
  let attributionHeader: string | undefined
  if (remaining[0]?.startsWith('x-anthropic-billing-header:')) {
    attributionHeader = remaining.shift()
  }

  // Extract CLI sysprompt prefix if matched by content
  let cliPrefix: string | undefined
  if (remaining[0] && CLI_SYSPROMPT_PREFIXES.has(remaining[0])) {
    cliPrefix = remaining.shift()
  }

  const useGlobal =
    shouldUseGlobalCacheScope() && !options?.skipGlobalCacheForSystemPrompt
  const boundaryIdx = remaining.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

  if (useGlobal && boundaryIdx >= 0) {
    const staticParts = remaining
      .slice(0, boundaryIdx)
      .filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY && s.length > 0)
    const dynamicParts = remaining
      .slice(boundaryIdx + 1)
      .filter(s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY && s.length > 0)

    if (attributionHeader) {
      blocks.push({ text: attributionHeader, cacheScope: null })
    }
    if (cliPrefix) {
      blocks.push({ text: cliPrefix, cacheScope: null })
    }
    if (staticParts.length > 0) {
      blocks.push({ text: staticParts.join('\n\n'), cacheScope: 'global' })
    }
    if (dynamicParts.length > 0) {
      blocks.push({ text: dynamicParts.join('\n\n'), cacheScope: null })
    }
    return blocks
  }

  // Default / 3P / non-deferred-MCP fallback: strip boundary and mark org-scoped
  const cleanedRest = remaining.filter(
    s => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY && s.length > 0,
  )
  if (attributionHeader) {
    blocks.push({ text: attributionHeader, cacheScope: null })
  }
  if (cliPrefix) {
    blocks.push({ text: cliPrefix, cacheScope: 'org' })
  }
  if (cleanedRest.length > 0) {
    blocks.push({ text: cleanedRest.join('\n\n'), cacheScope: 'org' })
  }
  return blocks
}

/**
 * Appends `systemContext` key/value sections to the end of the system prompt
 * array (after `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` so global cache prefix is preserved).
 */
export function appendSystemContext(
  systemPrompt: SystemPrompt | readonly string[],
  context: Record<string, string>,
): string[] {
  const entries = Object.entries(context).filter(([, value]) => Boolean(value))
  if (entries.length === 0) {
    return [...systemPrompt].filter(Boolean)
  }
  const serialized = entries
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return [...systemPrompt, serialized].filter(Boolean)
}

/**
 * Prepends `userContext` (layered `CLAUDE.md` + local date) as an `isMeta: true`
 * `<system-reminder>` first user message. No-op when `context` is empty or in
 * `NODE_ENV === 'test'` unless `forceInTests` is explicitly passed.
 */
export function prependUserContext(
  messages: readonly Message[],
  context: Record<string, string>,
  options?: { forceInTests?: boolean },
): Message[] {
  if (process.env.NODE_ENV === 'test' && !options?.forceInTests) {
    return [...messages]
  }
  const entries = Object.entries(context).filter(([, value]) => Boolean(value))
  if (entries.length === 0) {
    return [...messages]
  }

  const formattedEntries = entries
    .map(([key, value]) => `# ${key}\n${value}`)
    .join('\n\n')

  const reminderBody =
    `<system-reminder>\n` +
    `As you answer the user's questions, you can use the following context:\n` +
    `${formattedEntries}\n\n` +
    `      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n` +
    `</system-reminder>`

  const metaMessage = createUserMessage({
    content: reminderBody,
    isMeta: true,
  })
  return [metaMessage, ...messages]
}

/**
 * Serializes a tool definition into its Anthropic API schema with session-stable
 * caching and optional experimental beta field stripping.
 */
export async function toolToApiSchema(
  tool: Tool,
  options?: {
    deferLoading?: boolean
    cacheControl?: Record<string, unknown>
    getToolPermissionContext?: () => Promise<unknown> | unknown
    tools?: readonly Tool[]
    agents?: readonly unknown[]
  },
): Promise<ApiToolSchema> {
  const inputJsonSchema = tool.inputJSONSchema as
    | Record<string, unknown>
    | undefined
  const cacheKey = inputJsonSchema
    ? `${tool.name}:${jsonStringify(inputJsonSchema)}`
    : tool.name

  const toolSchemaCache = getToolSchemaCache()
  let base = toolSchemaCache.get(cacheKey)
  if (!base) {
    let description = ''
    if (typeof tool.prompt === 'function') {
      const promptFn = tool.prompt as (
        promptOptions?: Record<string, unknown>,
      ) => Promise<string> | string
      description = await promptFn({
        getToolPermissionContext: async () =>
          (await options?.getToolPermissionContext?.()) ??
          getEmptyToolPermissionContext(),
        tools: options?.tools ?? [],
        agents: options?.agents ?? [],
      })
    } else if (typeof tool.description === 'string') {
      description = tool.description
    }

    let inputSchema: Record<string, unknown>
    if (inputJsonSchema) {
      inputSchema = inputJsonSchema
    } else if (
      tool.inputSchema &&
      typeof tool.inputSchema === 'object' &&
      '_zod' in (tool.inputSchema as Record<string, unknown>)
    ) {
      inputSchema = zodToJsonSchema(tool.inputSchema as ZodTypeAny)
    } else {
      inputSchema = {
        type: 'object',
        properties: {},
      }
    }

    base = {
      name: tool.name,
      description,
      input_schema: inputSchema,
      ...(tool.strict === true ? { strict: true } : {}),
      ...(tool.eagerInputStreaming === true
        ? { eager_input_streaming: true }
        : {}),
    }
    toolSchemaCache.set(cacheKey, base)
  }

  const disableExperimental = isEnvTruthy(
    process.env.COPILOT_CLI_DISABLE_EXPERIMENTAL_BETAS,
  )

  if (disableExperimental) {
    return {
      name: base.name,
      description: base.description,
      input_schema: base.input_schema,
      ...(options?.cacheControl ? { cache_control: options.cacheControl } : {}),
    }
  }

  return {
    ...base,
    ...(options?.deferLoading ? { defer_loading: true } : {}),
    ...(options?.cacheControl ? { cache_control: options.cacheControl } : {}),
  }
}

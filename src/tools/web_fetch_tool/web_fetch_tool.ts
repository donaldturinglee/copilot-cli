/**
 * `WebFetchTool` (`WebFetch`):
 * Fetches web pages safely (HTTP->HTTPS upgrade, same-host/www redirect cap,
 * 15m/50MB LRU cache, lazy `turndown` HTML->Markdown conversion) and applies
 * the prompt via `queryHaiku` when authenticated (falling back gracefully to
 * raw Markdown content in offline/unit-test environments).
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import { WEB_FETCH_TOOL_NAME } from '../../constants/tools.js'
import { queryHaiku } from '../../services/api/claude.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import { getAuthTokenSource } from '../../utilities/auth.js'
import { getAssistantMessageText } from '../../utilities/messages.js'
import {
  formatPermissionRuleValue,
  getRulesForTool,
  matchWildcardPattern,
} from '../../utilities/permissions/rule_matching.js'
import { asSystemPrompt } from '../../utilities/system_prompt_type.js'
import { isPreapprovedHost } from './preapproved.js'
import { WEB_FETCH_TOOL_DESCRIPTION, WEB_FETCH_TOOL_PROMPT } from './prompt.js'
import { fetchUrlWithSafeRedirects, validateWebFetchUrl } from './utils.js'

const WebFetchInputSchema = z.object({
  url: z.string().describe('The URL to fetch content from'),
  prompt: z
    .string()
    .describe('The prompt describing what information to extract from the page'),
})

export type WebFetchInput = z.infer<typeof WebFetchInputSchema>

export interface WebFetchOutput {
  bytes: number
  code: number
  codeText: string
  result: string
  durationMs: number
  url: string
}

export const WebFetchTool = buildTool<WebFetchInput, WebFetchOutput>({
  name: WEB_FETCH_TOOL_NAME,
  searchHint: 'fetch web page content from a URL and convert HTML to markdown',
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  shouldDefer: true,
  inputSchema: WebFetchInputSchema,

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  isOpenWorld: () => true,
  interruptBehavior: () => 'cancel',

  toAutoClassifierInput(input) {
    return `${input.url} (${input.prompt.slice(0, 80)})`
  },

  userFacingName(input) {
    return input?.url ? `WebFetch(${input.url})` : WEB_FETCH_TOOL_NAME
  },

  async description() {
    return WEB_FETCH_TOOL_DESCRIPTION
  },

  async prompt() {
    return WEB_FETCH_TOOL_PROMPT
  },

  async validateInput(input) {
    const check = validateWebFetchUrl(input.url)
    if (!check.valid) {
      return { result: false, message: check.error, errorCode: 1 }
    }
    if (!input.prompt.trim()) {
      return {
        result: false,
        message: 'prompt must not be empty.',
        errorCode: 2,
      }
    }
    return { result: true }
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()

    const denyRules = getRulesForTool(
      permCtx,
      { name: WEB_FETCH_TOOL_NAME },
      'deny',
    )
    for (const rule of denyRules) {
      const pat = rule.ruleValue.ruleContent
      if (pat === undefined || matchWildcardPattern(input.url, pat)) {
        return {
          behavior: 'deny',
          message: `WebFetch denied by rule ${formatPermissionRuleValue(rule.ruleValue)}.`,
          decisionReason: { type: 'rule', rule },
        }
      }
    }

    if (permCtx.mode === 'bypassPermissions') {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'mode', mode: 'bypassPermissions' },
      }
    }

    const validated = validateWebFetchUrl(input.url)
    if (validated.valid && isPreapprovedHost(validated.parsed.hostname)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'other',
          reason: `Pre-approved documentation host (${validated.parsed.hostname})`,
        },
      }
    }

    const allowRules = getRulesForTool(
      permCtx,
      { name: WEB_FETCH_TOOL_NAME },
      'allow',
    )
    for (const rule of allowRules) {
      const pat = rule.ruleValue.ruleContent
      if (pat === undefined || matchWildcardPattern(input.url, pat)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'rule', rule },
        }
      }
    }

    return {
      behavior: 'ask',
      message: `Allow fetching URL: ${input.url}?`,
      updatedInput: input,
      decisionReason: { type: 'mode', mode: permCtx.mode },
    }
  },

  async call(input, context: ToolUseContext) {
    const start = Date.now()
    const fetched = await fetchUrlWithSafeRedirects(
      input.url,
      context.abortController.signal,
    )

    if (fetched.redirectedToDifferentHost) {
      return {
        data: {
          bytes: fetched.bytes,
          code: fetched.code,
          codeText: fetched.codeText,
          result: fetched.content,
          durationMs: Date.now() - start,
          url: fetched.url,
        },
      }
    }

    let resultText = fetched.content
    const hasAuth = getAuthTokenSource().hasToken
    if (hasAuth && process.env.NODE_ENV !== 'test' && fetched.content.length > 0) {
      try {
        const haikuResponse = await queryHaiku({
          systemPrompt: asSystemPrompt([
            'You are a concise web content extractor. Answer the user prompt based strictly on the provided webpage content.',
          ]),
          userPrompt: `Webpage URL: ${fetched.url}\n\nContent:\n${fetched.content}\n\nPrompt: ${input.prompt}`,
          signal: context.abortController.signal,
          options: {
            querySource: 'web_fetch_apply',
            enablePromptCaching: false,
          },
        })
        const extracted = getAssistantMessageText(haikuResponse).trim()
        if (extracted) {
          resultText = extracted
        }
      } catch {
        // Fall back to fetched Markdown content if Haiku post-processing fails
      }
    }

    return {
      data: {
        bytes: fetched.bytes,
        code: fetched.code,
        codeText: fetched.codeText,
        result: resultText,
        durationMs: Date.now() - start,
        url: fetched.url,
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: output.result,
    }
  },
})

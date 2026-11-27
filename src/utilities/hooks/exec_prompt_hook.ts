/**
 * Single-turn LLM `prompt` hook executor (`execPromptHook`) backed by
 * `sideQuery`, with injectable test transport for deterministic unit testing.
 */

import type { PromptHook } from '../../schemas/hooks.js'
import type { HookEvent, HookResult } from '../../types/hooks.js'
import { createCombinedAbortSignal } from '../combined_abort_signal.js'
import { errorMessage } from '../errors.js'
import { getDefaultHaikuModel } from '../model/model.js'
import { sideQuery } from '../side_query.js'
import {
  parseHookVerificationVerdict,
  renderHookPrompt,
} from './api_query_hook_helper.js'

const DEFAULT_PROMPT_HOOK_TIMEOUT_MS = 30_000

export type PromptHookTransport = (params: {
  model: string
  prompt: string
  hookEvent: HookEvent
  signal?: AbortSignal
}) => Promise<string>

let testPromptHookTransport: PromptHookTransport | null = null

export function setPromptHookTransportForTesting(
  transport: PromptHookTransport | null,
): void {
  testPromptHookTransport = transport
}

export async function execPromptHook(
  hook: PromptHook,
  hookEvent: HookEvent,
  jsonInput: string,
  signal?: AbortSignal,
): Promise<HookResult> {
  const timeoutMs = (hook.timeout ?? 30) * 1000 || DEFAULT_PROMPT_HOOK_TIMEOUT_MS
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs,
  })
  const model = hook.model ?? getDefaultHaikuModel()
  const renderedPrompt = renderHookPrompt(hook.prompt, jsonInput)

  try {
    let rawText: string
    if (testPromptHookTransport) {
      rawText = await testPromptHookTransport({
        model,
        prompt: renderedPrompt,
        hookEvent,
        signal: combinedSignal,
      })
    } else {
      const response = await sideQuery({
        model,
        system:
          'You are evaluating a Copilot CLI lifecycle hook condition. Respond ONLY with a JSON object: {"ok": true} to allow/approve, or {"ok": false, "reason": "concise explanation"} to block.',
        messages: [{ role: 'user', content: renderedPrompt }],
        maxTokens: 512,
        signal: combinedSignal,
        querySource: 'hook_prompt',
      })
      rawText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
    }

    const verdict = parseHookVerificationVerdict(rawText)
    if (verdict.ok) {
      return {
        outcome: 'success',
        ...(verdict.reason ? { additionalContext: verdict.reason } : {}),
      }
    }

    const reason = verdict.reason ?? 'Blocked by prompt hook'
    return {
      outcome: 'blocking',
      blockingError: {
        blockingError: reason,
        command: hook.prompt,
      },
      permissionBehavior: hookEvent === 'PreToolUse' ? 'deny' : undefined,
      hookPermissionDecisionReason: reason,
    }
  } catch (error) {
    if (combinedSignal.aborted) {
      return { outcome: 'cancelled' }
    }
    return {
      outcome: 'non_blocking_error',
      hookPermissionDecisionReason: `Prompt hook error: ${errorMessage(error)}`,
    }
  } finally {
    cleanup()
  }
}

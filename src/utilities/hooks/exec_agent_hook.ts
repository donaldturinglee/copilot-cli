/**
 * Agentic verifier `agent` hook executor (`execAgentHook`).
 * Runs a bounded verification query (default timeout 60s) and translates the
 * verifier's `{ ok, reason }` decision into a `HookResult`.
 */

import type { AgentHook } from '../../schemas/hooks.js'
import type { HookEvent, HookResult } from '../../types/hooks.js'
import type { Message } from '../../types/message.js'
import { createCombinedAbortSignal } from '../combined_abort_signal.js'
import { errorMessage } from '../errors.js'
import { getDefaultHaikuModel } from '../model/model.js'
import { sideQuery } from '../side_query.js'
import {
  parseHookVerificationVerdict,
  renderHookPrompt,
} from './api_query_hook_helper.js'

const DEFAULT_AGENT_HOOK_TIMEOUT_MS = 60_000

export type AgentHookExecutorFn = (params: {
  model: string
  prompt: string
  hookEvent: HookEvent
  messages: readonly Message[]
  signal?: AbortSignal
}) => Promise<string>

let testAgentHookExecutor: AgentHookExecutorFn | null = null

export function setAgentHookExecutorForTesting(
  executor: AgentHookExecutorFn | null,
): void {
  testAgentHookExecutor = executor
}

export async function execAgentHook(
  hook: AgentHook,
  hookEvent: HookEvent,
  jsonInput: string,
  messages: readonly Message[] = [],
  signal?: AbortSignal,
): Promise<HookResult> {
  const timeoutMs = (hook.timeout ?? 60) * 1000 || DEFAULT_AGENT_HOOK_TIMEOUT_MS
  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs,
  })
  const model = hook.model ?? getDefaultHaikuModel()
  const renderedPrompt = renderHookPrompt(hook.prompt, jsonInput)

  try {
    let rawText: string
    if (testAgentHookExecutor) {
      rawText = await testAgentHookExecutor({
        model,
        prompt: renderedPrompt,
        hookEvent,
        messages,
        signal: combinedSignal,
      })
    } else {
      const response = await sideQuery({
        model,
        system:
          'You are an automated verification agent running a Copilot CLI lifecycle hook. Verify the condition and reply ONLY with JSON: {"ok": true} if satisfied, or {"ok": false, "reason": "specific actionable reason"} if not.',
        messages: [{ role: 'user', content: renderedPrompt }],
        maxTokens: 1024,
        signal: combinedSignal,
        querySource: 'hook_agent',
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

    const reason = verdict.reason ?? 'Verification failed in agent hook'
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
      hookPermissionDecisionReason: `Agent hook error: ${errorMessage(error)}`,
    }
  } finally {
    cleanup()
  }
}

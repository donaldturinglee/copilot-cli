/**
 * Tool lifecycle hook orchestration facade (`PreToolUse`, `PostToolUse`,
 * `PostToolUseFailure`) with strict `deny > ask > allow` precedence and
 * Phase 4 hook engine registration slots.
 */

import type { AnyTool, ToolUseContext } from '../../tool.js'
import type { Message } from '../../types/message.js'
import type { PermissionBehavior } from '../../types/permissions.js'

export interface PreToolUseHookOutcome {
  decision?: PermissionBehavior
  reason?: string
  updatedInput?: Record<string, unknown>
  additionalContext: string[]
  preventContinuation: boolean
  messages: Message[]
}

export interface PostToolUseHookOutcome {
  additionalContext: string[]
  preventContinuation: boolean
  messages: Message[]
}

export interface PostToolUseFailureHookOutcome {
  additionalContext: string[]
  messages: Message[]
}

export interface ToolHookRunner {
  runPreToolUse?: (params: {
    tool: AnyTool
    input: Record<string, unknown>
    toolUseId: string
    context: ToolUseContext
  }) => Promise<Partial<PreToolUseHookOutcome>>
  runPostToolUse?: (params: {
    tool: AnyTool
    input: Record<string, unknown>
    output: unknown
    toolUseId: string
    context: ToolUseContext
  }) => Promise<Partial<PostToolUseHookOutcome>>
  runPostToolUseFailure?: (params: {
    tool: AnyTool
    input: Record<string, unknown>
    error: string
    toolUseId: string
    context: ToolUseContext
  }) => Promise<Partial<PostToolUseFailureHookOutcome>>
}

let activeHookRunner: ToolHookRunner | null = null

/**
 * Registers the Phase 4 full lifecycle hook executor without introducing a
 * backward import from Phase 3 into Phase 4.
 */
export function registerToolHookRunner(runner: ToolHookRunner | null): void {
  activeHookRunner = runner
}

/**
 * Resolves multiple hook permission decisions using strict security precedence:
 * `deny > ask > allow`.
 */
export function resolveHookPermissionDecision(
  decisions: readonly (PermissionBehavior | undefined)[],
): PermissionBehavior | undefined {
  let resolved: PermissionBehavior | undefined
  for (const decision of decisions) {
    if (!decision) continue
    if (decision === 'deny') return 'deny'
    if (decision === 'ask') {
      resolved = 'ask'
    } else if (decision === 'allow' && resolved === undefined) {
      resolved = 'allow'
    }
  }
  return resolved
}

export async function runPreToolUseHooks(params: {
  tool: AnyTool
  input: Record<string, unknown>
  toolUseId: string
  context: ToolUseContext
}): Promise<PreToolUseHookOutcome> {
  if (!activeHookRunner?.runPreToolUse) {
    return {
      additionalContext: [],
      preventContinuation: false,
      messages: [],
    }
  }
  const outcome = await activeHookRunner.runPreToolUse(params)
  return {
    decision: outcome.decision,
    reason: outcome.reason,
    updatedInput: outcome.updatedInput,
    additionalContext: outcome.additionalContext ?? [],
    preventContinuation: Boolean(outcome.preventContinuation),
    messages: outcome.messages ?? [],
  }
}

export async function runPostToolUseHooks(params: {
  tool: AnyTool
  input: Record<string, unknown>
  output: unknown
  toolUseId: string
  context: ToolUseContext
}): Promise<PostToolUseHookOutcome> {
  if (!activeHookRunner?.runPostToolUse) {
    return {
      additionalContext: [],
      preventContinuation: false,
      messages: [],
    }
  }
  const outcome = await activeHookRunner.runPostToolUse(params)
  return {
    additionalContext: outcome.additionalContext ?? [],
    preventContinuation: Boolean(outcome.preventContinuation),
    messages: outcome.messages ?? [],
  }
}

export async function runPostToolUseFailureHooks(params: {
  tool: AnyTool
  input: Record<string, unknown>
  error: string
  toolUseId: string
  context: ToolUseContext
}): Promise<PostToolUseFailureHookOutcome> {
  if (!activeHookRunner?.runPostToolUseFailure) {
    return {
      additionalContext: [],
      messages: [],
    }
  }
  const outcome = await activeHookRunner.runPostToolUseFailure(params)
  return {
    additionalContext: outcome.additionalContext ?? [],
    messages: outcome.messages ?? [],
  }
}

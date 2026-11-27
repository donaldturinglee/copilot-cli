/**
 * Wires the Phase 4 Hooks engine, `PermissionRequest` hooks, and OS sandbox
 * auto-allow checker into Phase 3 execution seams (`tool_hooks.ts` &
 * `permissions.ts`) without creating backward circular imports.
 */

import {
  registerToolHookRunner,
  resolveHookPermissionDecision,
} from '../../services/tools/tool_hooks.js'
import { shouldUseSandbox } from '../../tools/bash_tool/should_use_sandbox.js'
import {
  executePermissionDeniedHooks,
  executePermissionRequestHooks,
  executePostToolUseFailureHooks,
  executePostToolUseHooks,
  executePreToolUseHooks,
} from '../hooks.js'
import {
  registerPermissionRequestHookRunner,
  registerSandboxAutoAllowChecker,
} from '../permissions/permissions.js'
import { SandboxManager } from '../sandbox/sandbox_adapter.js'

let bootstrapped = false

export function ensurePhase4HooksBootstrapped(): void {
  if (bootstrapped) return
  bootstrapped = true

  registerToolHookRunner({
    async runPreToolUse({ tool, input, toolUseId, context }) {
      const mode = context.getAppState?.().toolPermissionContext.mode
      const res = await executePreToolUseHooks({
        toolName: tool.name,
        toolInput: input,
        toolUseId,
        permissionMode: mode,
        toolUseContext: context,
        signal: context.abortController.signal,
      })

      const decision = resolveHookPermissionDecision([
        res.permissionBehavior === 'allow' ||
        res.permissionBehavior === 'deny' ||
        res.permissionBehavior === 'ask'
          ? res.permissionBehavior
          : res.blockingErrors.length > 0
            ? 'deny'
            : undefined,
      ])

      const reason =
        res.hookPermissionDecisionReason ??
        res.blockingErrors[0]?.blockingError ??
        res.stopReason

      return {
        decision,
        reason,
        updatedInput: res.updatedInput,
        additionalContext: res.additionalContexts,
        preventContinuation: res.preventContinuation,
        messages: res.messages,
      }
    },

    async runPostToolUse({ tool, input, output, toolUseId, context }) {
      const mode = context.getAppState?.().toolPermissionContext.mode
      const res = await executePostToolUseHooks({
        toolName: tool.name,
        toolInput: input,
        toolResponse: output,
        toolUseId,
        permissionMode: mode,
        toolUseContext: context,
        signal: context.abortController.signal,
      })
      return {
        additionalContext: res.additionalContexts,
        preventContinuation: res.preventContinuation,
        messages: res.messages,
      }
    },

    async runPostToolUseFailure({ tool, input, error, toolUseId, context }) {
      const mode = context.getAppState?.().toolPermissionContext.mode
      const res = await executePostToolUseFailureHooks({
        toolName: tool.name,
        toolInput: input,
        toolUseId,
        error,
        permissionMode: mode,
        toolUseContext: context,
        signal: context.abortController.signal,
      })
      return {
        additionalContext: res.additionalContexts,
        messages: res.messages,
      }
    },

    async runPermissionDenied({ tool, input, reason, toolUseId, context }) {
      const mode = context.getAppState?.().toolPermissionContext.mode
      const res = await executePermissionDeniedHooks({
        toolName: tool.name,
        toolInput: input,
        toolUseId,
        reason,
        permissionMode: mode,
        toolUseContext: context,
        signal: context.abortController.signal,
      })
      return {
        retry: res.retry,
        messages: res.messages,
      }
    },
  })

  registerPermissionRequestHookRunner(async ({ tool, input, context, suggestions }) => {
    const mode = context.getAppState?.().toolPermissionContext.mode
    const { decision } = await executePermissionRequestHooks({
      toolName: tool.name,
      toolInput: input,
      suggestions,
      permissionMode: mode,
      toolUseContext: context,
      signal: context.abortController.signal,
    })
    if (!decision) return null
    if (decision.behavior === 'allow') {
      return {
        behavior: 'allow',
        updatedInput: decision.updatedInput,
        updatedPermissions: decision.updatedPermissions,
        hookName: 'PermissionRequest',
      }
    }
    return {
      behavior: 'deny',
      message: decision.message,
      interrupt: decision.interrupt,
      hookName: 'PermissionRequest',
    }
  })

  registerSandboxAutoAllowChecker(input => {
    if (!SandboxManager.isAutoAllowBashIfSandboxedEnabled()) {
      return false
    }
    const command = typeof input.command === 'string' ? input.command : undefined
    const dangerouslyDisableSandbox =
      typeof input.dangerouslyDisableSandbox === 'boolean'
        ? input.dangerouslyDisableSandbox
        : undefined
    return shouldUseSandbox({ command, dangerouslyDisableSandbox })
  })
}

export function resetPhase4BootstrapForTesting(): void {
  bootstrapped = false
}

/**
 * Authoritative 6-mode Permission Evaluation Engine (`hasPermissionsToUseTool`
 * & `checkRuleBasedPermissions`).
 *
 * Precedence (Steps 1a–1g are STRICTLY IMMUNE to `bypassPermissions`!):
 * - 1a: Blanket `deny` rule for tool (or MCP server prefix) -> `deny`
 * - 1b: Blanket `ask` rule for tool (unless sandboxed auto-allow exception applies) -> `ask`
 * - 1c: Tool-specific `tool.checkPermissions(input, context)` evaluation
 * - 1d: Tool returned `deny` -> `deny`
 * - 1e: `tool.requiresUserInteraction?.(input)` -> `ask`
 * - 1f: Tool returned content-specific `ask` rule (`decisionReason.type === 'rule'`) -> `ask`
 * - 1g: Tool returned sensitive-path `safetyCheck` (`decisionReason.type === 'safetyCheck'`) -> `ask`
 * - 2a: `bypassPermissions` mode (unless killed by policy) -> `allow`
 * - 2b: Blanket `allow` rule for tool (with optional `autoAllowBashIfSandboxed`) -> `allow`
 * - 3:  Remaining `passthrough` -> `ask`, or preserve `allow` / `ask`
 *
 * Post-evaluation mode transformations:
 * - `dontAsk` mode: any remaining `ask` converts to fail-closed `deny`
 * - `auto` mode: allowlisted read-only tools -> `allow`; `acceptEdits` fast-path
 *   for safe workspace edits -> `allow`; otherwise invoke 2-stage transcript
 *   classifier (`classifyYoloAction`), tracking denials in `AppState.denialTracking`
 *   and circuit-breaking at 3 consecutive or 20 total denials!
 * - `shouldAvoidPermissionPrompts` (headless/non-interactive): runs registered
 *   `PermissionRequest` hooks if any, otherwise converts remaining `ask` to `deny`.
 */

import type { AnyTool, ToolUseContext } from '../../tool.js'
import type { AssistantMessage } from '../../types/message.js'
import type {
  PermissionBehavior,
  PermissionDecision,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  PermissionUpdate,
  ToolPermissionContext,
} from '../../types/permissions.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import { recordAutoModeDenial } from '../auto_mode_denials.js'
import { recordClassifierApproval } from '../classifier_approvals.js'
import { isBypassPermissionsDisabled } from './bypass_permissions_killswitch.js'
import {
  isAutoModeAllowlistedTool,
  isAutoModeEditTool,
} from './classifier_decision.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from './denial_tracking.js'
import { pathInAllowedWorkingPath } from './filesystem.js'
import {
  isRuleToolNameMatch,
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permission_rule_parser.js'
import { applyPermissionUpdates } from './rule_matching.js'
import { classifyYoloAction } from './yolo_classifier.js'

const RULE_SOURCES_PRECEDENCE: readonly PermissionRuleSource[] = [
  'policySettings',
  'flagSettings',
  'cliArg',
  'command',
  'localSettings',
  'projectSettings',
  'userSettings',
  'session',
]

export interface PermissionRequestHookOutcome {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  message?: string
  interrupt?: boolean
  hookName?: string
}

export type PermissionRequestHookRunner = (params: {
  tool: AnyTool
  input: Record<string, unknown>
  toolUseId: string
  context: ToolUseContext
  suggestions?: PermissionUpdate[]
}) => Promise<PermissionRequestHookOutcome | null>

let permissionRequestHookRunner: PermissionRequestHookRunner | null = null

/**
 * Registers the Phase 4 `PermissionRequest` hook runner (breaks circular
 * dependency between `permissions.ts` and `hooks.ts`).
 */
export function registerPermissionRequestHookRunner(
  runner: PermissionRequestHookRunner | null,
): void {
  permissionRequestHookRunner = runner
}

export type SandboxAutoAllowChecker = (input: Record<string, unknown>) => boolean

let sandboxAutoAllowChecker: SandboxAutoAllowChecker | null = null

/**
 * Registers the Phase 4.3 `SandboxManager` auto-allow checker for BashTool.
 */
export function registerSandboxAutoAllowChecker(
  checker: SandboxAutoAllowChecker | null,
): void {
  sandboxAutoAllowChecker = checker
}

function collectRulesForBehavior(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  behavior: PermissionBehavior,
): PermissionRule[] {
  const sourceMap =
    behavior === 'deny'
      ? permissionContext.alwaysDenyRules
      : behavior === 'ask'
        ? permissionContext.alwaysAskRules
        : permissionContext.alwaysAllowRules

  const rules: PermissionRule[] = []
  for (const source of RULE_SOURCES_PRECEDENCE) {
    const entries = sourceMap[source]
    if (!entries) continue
    for (const raw of entries) {
      rules.push({
        source,
        ruleBehavior: behavior,
        ruleValue: permissionRuleValueFromString(raw),
      })
    }
  }
  return rules
}

/**
 * Finds the first blanket (content-less) rule matching `tool` for `behavior`.
 */
export function getBlanketRuleMatchingTool(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  behavior: PermissionBehavior,
): PermissionRule | undefined {
  return collectRulesForBehavior(permissionContext, behavior).find(
    rule =>
      rule.ruleValue.ruleContent === undefined &&
      isRuleToolNameMatch(rule.ruleValue.toolName, tool),
  )
}

/**
 * Returns a `Map<ruleContent, PermissionRule>` of all content-scoped rules
 * matching `toolName` for `behavior` (highest-precedence source wins on ties).
 */
export function getRuleByContentsForToolName(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  toolName: string,
  behavior: PermissionBehavior,
  aliases?: readonly string[],
): Map<string, PermissionRule> {
  const map = new Map<string, PermissionRule>()
  const rules = collectRulesForBehavior(permissionContext, behavior)
  const target = { name: toolName, aliases }
  for (const rule of rules) {
    if (
      rule.ruleValue.ruleContent !== undefined &&
      isRuleToolNameMatch(rule.ruleValue.toolName, target)
    ) {
      if (!map.has(rule.ruleValue.ruleContent)) {
        map.set(rule.ruleValue.ruleContent, rule)
      }
    }
  }
  return map
}

export function getRuleByContentsForTool(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  tool: { readonly name: string; readonly aliases?: readonly string[] },
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  return getRuleByContentsForToolName(
    permissionContext,
    tool.name,
    behavior,
    tool.aliases,
  )
}

export function createPermissionRequestMessage(
  toolName: string,
  reason?: string,
): string {
  return reason
    ? `Permission required to use ${toolName}: ${reason}`
    : `Permission required to use ${toolName}.`
}

/**
 * Rule-based security check executed both during initial permission evaluation
 * AND re-executed after `PreToolUse` `updatedInput` rewrites so hooks can NEVER
 * smuggle denied commands or sensitive-path edits past security boundaries!
 */
export async function checkRuleBasedPermissions(
  tool: AnyTool,
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<PermissionResult<Record<string, unknown>>> {
  const permissionContext =
    context.getAppState?.().toolPermissionContext ??
    getEmptyToolPermissionContext()

  // Step 1a: Blanket deny rule (immune to bypassPermissions)
  const blanketDeny = getBlanketRuleMatchingTool(permissionContext, tool, 'deny')
  if (blanketDeny) {
    return {
      behavior: 'deny',
      message: `Tool ${tool.name} is denied by rule ${permissionRuleValueToString(blanketDeny.ruleValue)}.`,
      decisionReason: { type: 'rule', rule: blanketDeny },
    }
  }

  // Step 1b: Blanket ask rule (immune to bypassPermissions, unless Bash sandbox auto-allow applies)
  const blanketAsk = getBlanketRuleMatchingTool(permissionContext, tool, 'ask')
  if (blanketAsk) {
    const isSandboxedBashAutoAllow =
      normalizeLegacyToolName(tool.name) === 'Bash' &&
      sandboxAutoAllowChecker !== null &&
      sandboxAutoAllowChecker(input)

    if (!isSandboxedBashAutoAllow) {
      return {
        behavior: 'ask',
        message: createPermissionRequestMessage(
          tool.name,
          `matched ask rule ${permissionRuleValueToString(blanketAsk.ruleValue)}`,
        ),
        updatedInput: input,
        decisionReason: { type: 'rule', rule: blanketAsk },
      }
    }
  }

  // Step 1c: Tool-specific permission evaluation
  let toolResult: PermissionResult<Record<string, unknown>>
  try {
    toolResult = await tool.checkPermissions(input, context)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    return {
      behavior: 'ask',
      message: `Permission check error for ${tool.name}: ${errMsg}`,
      updatedInput: input,
      decisionReason: { type: 'other', reason: errMsg },
    }
  }

  // Step 1d: Explicit tool-level deny (immune to bypassPermissions)
  if (toolResult.behavior === 'deny') {
    return toolResult
  }

  // Step 1e: Tool requires direct user interaction (e.g. AskUserQuestion / ExitPlanMode)
  if (tool.requiresUserInteraction?.()) {
    return {
      behavior: 'ask',
      message:
        'message' in toolResult && toolResult.message
          ? toolResult.message
          : createPermissionRequestMessage(
              tool.name,
              'tool requires user interaction',
            ),
      updatedInput:
        'updatedInput' in toolResult && toolResult.updatedInput
          ? toolResult.updatedInput
          : input,
      decisionReason:
        toolResult.decisionReason ?? {
          type: 'other',
          reason: 'requiresUserInteraction',
        },
    }
  }

  // Step 1f: Content-specific `ask` rule (immune to bypassPermissions!)
  if (
    toolResult.behavior === 'ask' &&
    toolResult.decisionReason?.type === 'rule' &&
    toolResult.decisionReason.rule.ruleBehavior === 'ask'
  ) {
    return toolResult
  }

  // Step 1g: Sensitive-path / security `safetyCheck` (immune to bypassPermissions!)
  if (
    toolResult.behavior === 'ask' &&
    toolResult.decisionReason?.type === 'safetyCheck'
  ) {
    return toolResult
  }

  // Step 2a: `bypassPermissions` mode (only reached AFTER Steps 1a–1g!)
  if (
    permissionContext.mode === 'bypassPermissions' &&
    !isBypassPermissionsDisabled()
  ) {
    return {
      behavior: 'allow',
      updatedInput:
        'updatedInput' in toolResult && toolResult.updatedInput
          ? toolResult.updatedInput
          : input,
      decisionReason: { type: 'mode', mode: 'bypassPermissions' },
    }
  }

  // Step 2b: Blanket allow rule for tool
  const blanketAllow = getBlanketRuleMatchingTool(
    permissionContext,
    tool,
    'allow',
  )
  if (blanketAllow) {
    return {
      behavior: 'allow',
      updatedInput:
        'updatedInput' in toolResult && toolResult.updatedInput
          ? toolResult.updatedInput
          : input,
      decisionReason: { type: 'rule', rule: blanketAllow },
    }
  }

  // Step 3: Preserve allow/ask or convert passthrough -> ask
  if (toolResult.behavior === 'passthrough') {
    return {
      behavior: 'ask',
      message:
        toolResult.message || createPermissionRequestMessage(tool.name),
      updatedInput: input,
      decisionReason: toolResult.decisionReason,
      suggestions: toolResult.suggestions,
      blockedPath: toolResult.blockedPath,
      pendingClassifierCheck: toolResult.pendingClassifierCheck,
    }
  }

  return toolResult
}

/**
 * Evaluates a tool invocation through the complete 6-mode permission pipeline:
 * 1. Rule & tool-specific checks (`checkRuleBasedPermissions`)
 * 2. `dontAsk` fail-closed conversion
 * 3. `auto` mode fast-paths + 2-stage transcript classifier + circuit breaker
 * 4. Headless `PermissionRequest` hooks & `shouldAvoidPermissionPrompts` fail-closed denial
 */
export async function hasPermissionsToUseTool(
  tool: AnyTool,
  input: Record<string, unknown>,
  context: ToolUseContext,
  _assistantMessage: AssistantMessage,
  toolUseId: string,
): Promise<PermissionDecision<Record<string, unknown>>> {
  const appState = context.getAppState?.()
  const permissionContext =
    appState?.toolPermissionContext ?? getEmptyToolPermissionContext()

  const baseResult = await checkRuleBasedPermissions(tool, input, context)

  // Fast exit for already-decided allow or deny
  if (baseResult.behavior === 'allow' || baseResult.behavior === 'deny') {
    return baseResult
  }

  // Remaining result is `ask` (or normalized from `passthrough`)
  let askResult: PermissionDecision<Record<string, unknown>> =
    baseResult.behavior === 'ask'
      ? baseResult
      : {
          behavior: 'ask',
          message: baseResult.message || createPermissionRequestMessage(tool.name),
          updatedInput: input,
          decisionReason: baseResult.decisionReason,
          suggestions: baseResult.suggestions,
          blockedPath: baseResult.blockedPath,
        }

  const effectiveInput =
    askResult.behavior === 'ask' && askResult.updatedInput
      ? askResult.updatedInput
      : input

  // Mode transformation A: `dontAsk` converts any unapproved `ask` into fail-closed `deny`
  if (permissionContext.mode === 'dontAsk') {
    return {
      behavior: 'deny',
      message: `${askResult.message} (Denied automatically in dontAsk mode.)`,
      decisionReason: askResult.decisionReason ?? {
        type: 'mode',
        mode: 'dontAsk',
      },
      toolUseId,
    }
  }

  // Mode transformation B: `auto` mode (allowlist -> acceptEdits fast-path -> 2-stage classifier + circuit breaker)
  if (permissionContext.mode === 'auto') {
    const isNonApprovableSafetyCheck =
      askResult.decisionReason?.type === 'safetyCheck' &&
      !askResult.decisionReason.classifierApprovable
    const isExplicitAskRule =
      askResult.decisionReason?.type === 'rule' &&
      askResult.decisionReason.rule.ruleBehavior === 'ask'
    const requiresInteractive = Boolean(tool.requiresUserInteraction?.())

    // Non-approvable safetyChecks (`.git`, `.copilot`, settings, Windows bypasses),
    // explicit `ask` rules, and interactive tools NEVER bypass human confirmation in `auto` mode!
    if (!isNonApprovableSafetyCheck && !isExplicitAskRule && !requiresInteractive) {
      // Fast-path 1: Allowlisted read-only / safe introspection tools
      if (isAutoModeAllowlistedTool(tool.name)) {
        return {
          behavior: 'allow',
          updatedInput: effectiveInput,
          decisionReason: { type: 'mode', mode: 'auto' },
          toolUseId,
        }
      }

      // Fast-path 2: Safe file edits inside allowed working directories
      if (isAutoModeEditTool(tool.name)) {
        const targetPath = tool.getPath?.(effectiveInput)
        if (
          targetPath &&
          pathInAllowedWorkingPath(targetPath, permissionContext)
        ) {
          return {
            behavior: 'allow',
            updatedInput: effectiveInput,
            decisionReason: { type: 'mode', mode: 'auto' },
            toolUseId,
          }
        }
      }

      // Circuit breaker check BEFORE invoking classifier
      const currentDenialTracking =
        appState?.denialTracking ?? createDenialTrackingState()

      if (shouldFallbackToPrompting(currentDenialTracking)) {
        const cbReason = `Auto-mode classifier circuit breaker tripped (${currentDenialTracking.consecutiveDenials}/${DENIAL_LIMITS.maxConsecutive} consecutive, ${currentDenialTracking.totalDenials}/${DENIAL_LIMITS.maxTotal} total denials). Falling back to user approval.`
        askResult = {
          behavior: 'ask',
          message: cbReason,
          updatedInput: effectiveInput,
          decisionReason: {
            type: 'classifier',
            classifier: 'auto-mode-circuit-breaker',
            reason: cbReason,
          },
        }
      } else {
        const customSummary = tool.toAutoClassifierInput?.(effectiveInput)
        const classifierResult = await classifyYoloAction({
          toolName: tool.name,
          input: effectiveInput,
          customSummary,
          messages: context.messages,
          signal: context.abortController.signal,
        })

        if (!classifierResult.shouldBlock) {
          // Reset consecutive denial counter on approval
          context.setAppState?.(prev => ({
            ...prev,
            denialTracking: recordSuccess(
              prev.denialTracking ?? createDenialTrackingState(),
            ),
          }))
          recordClassifierApproval({
            toolName: tool.name,
            summary: customSummary ?? tool.name,
            reason: classifierResult.reason,
            stage: classifierResult.stage ?? 'fast',
          })
          return {
            behavior: 'allow',
            updatedInput: effectiveInput,
            decisionReason: {
              type: 'classifier',
              classifier: `auto-mode-${classifierResult.stage ?? 'fast'}`,
              reason: classifierResult.reason,
            },
            toolUseId,
          }
        }

        // Classifier blocked: update denial tracking circuit breaker
        const nextTracking = recordDenial(currentDenialTracking)
        context.setAppState?.(prev => ({
          ...prev,
          denialTracking: recordDenial(
            prev.denialTracking ?? createDenialTrackingState(),
          ),
        }))
        recordAutoModeDenial({
          toolName: tool.name,
          display: customSummary ?? tool.name,
          reason: classifierResult.reason,
        })

        const breakerNotice = shouldFallbackToPrompting(nextTracking)
          ? ` Circuit breaker reached (${nextTracking.consecutiveDenials} consecutive / ${nextTracking.totalDenials} total).`
          : ''

        return {
          behavior: 'deny',
          message: `Auto-mode classifier blocked ${tool.name}: ${classifierResult.reason}${breakerNotice}`,
          decisionReason: {
            type: 'classifier',
            classifier: `auto-mode-${classifierResult.stage ?? 'thinking'}`,
            reason: classifierResult.reason,
          },
          toolUseId,
        }
      }
    }
  }

  // Mode transformation C: Headless / non-interactive `PermissionRequest` hooks & fail-closed denial
  const avoidPrompts =
    Boolean(permissionContext.shouldAvoidPermissionPrompts) ||
    Boolean(context.options?.isNonInteractiveSession)

  if (askResult.behavior === 'ask' && permissionRequestHookRunner) {
    const hookDecision = await permissionRequestHookRunner({
      tool,
      input: effectiveInput,
      toolUseId,
      context,
      suggestions: askResult.suggestions,
    })

    if (hookDecision) {
      if (hookDecision.behavior === 'allow') {
        if (hookDecision.updatedPermissions?.length) {
          context.setAppState?.(prev => ({
            ...prev,
            toolPermissionContext: applyPermissionUpdates(
              prev.toolPermissionContext,
              hookDecision.updatedPermissions!,
            ),
          }))
        }
        const finalInput = hookDecision.updatedInput ?? effectiveInput
        // SECURITY: Re-verify rule-based deny & safetyCheck after PermissionRequest updatedInput!
        const recheck = await checkRuleBasedPermissions(tool, finalInput, context)
        if (
          recheck.behavior === 'deny' ||
          (recheck.behavior === 'ask' &&
            recheck.decisionReason?.type === 'safetyCheck')
        ) {
          return recheck.behavior === 'deny'
            ? recheck
            : {
                behavior: 'deny',
                message: recheck.message,
                decisionReason: recheck.decisionReason!,
                toolUseId,
              }
        }
        return {
          behavior: 'allow',
          updatedInput: finalInput,
          decisionReason: {
            type: 'hook',
            hookName: hookDecision.hookName ?? 'PermissionRequest',
          },
          toolUseId,
        }
      }

      return {
        behavior: 'deny',
        message:
          hookDecision.message ||
          `Permission denied for ${tool.name} by PermissionRequest hook.`,
        decisionReason: {
          type: 'hook',
          hookName: hookDecision.hookName ?? 'PermissionRequest',
          reason: hookDecision.message,
        },
        toolUseId,
      }
    }
  }

  if (avoidPrompts && askResult.behavior === 'ask') {
    return {
      behavior: 'deny',
      message: `${askResult.message} (Non-interactive session cannot prompt for confirmation.)`,
      decisionReason: askResult.decisionReason ?? {
        type: 'mode',
        mode: permissionContext.mode,
      },
      toolUseId,
    }
  }

  return askResult
}

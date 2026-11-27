/**
 * High-level permission mode transition helper managing plan-mode save/restore
 * (`prePlanMode`), auto-mode dangerous-rule stripping, and bypass killswitch.
 */

import type {
  PermissionMode,
  ToolPermissionContext,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import { setAutoModeActive } from './auto_mode_state.js'
import { isBypassPermissionsDisabled } from './bypass_permissions_killswitch.js'
import {
  restoreStrippedDangerousRules,
  stripDangerousAllowRulesForAutoMode,
} from './dangerous_patterns.js'
import { cloneRulesBySource } from './rule_matching.js'

/**
 * Transitions `context` to `targetMode` while enforcing security invariants:
 * - Refuses `bypassPermissions` when disabled by policy.
 * - Strips dangerous allow rules when entering `auto` mode and restores them
 *   when leaving `auto` mode.
 * - Remembers `prePlanMode` when entering `plan` mode.
 */
export function transitionPermissionMode(
  context: DeepImmutable<ToolPermissionContext>,
  targetMode: PermissionMode,
): ToolPermissionContext {
  const effectiveTarget: PermissionMode =
    targetMode === 'bypassPermissions' && isBypassPermissionsDisabled()
      ? 'default'
      : targetMode

  let working: ToolPermissionContext = {
    ...context,
    additionalWorkingDirectories: new Map(context.additionalWorkingDirectories),
    alwaysAllowRules: cloneRulesBySource(context.alwaysAllowRules),
    alwaysDenyRules: cloneRulesBySource(context.alwaysDenyRules),
    alwaysAskRules: cloneRulesBySource(context.alwaysAskRules),
    ...(context.strippedDangerousRules
      ? {
          strippedDangerousRules: cloneRulesBySource(
            context.strippedDangerousRules,
          ),
        }
      : { strippedDangerousRules: undefined }),
  }

  if (context.mode === 'auto' && effectiveTarget !== 'auto') {
    working = restoreStrippedDangerousRules(working)
    setAutoModeActive(false)
  }

  if (effectiveTarget === 'auto') {
    working = stripDangerousAllowRulesForAutoMode(working)
    setAutoModeActive(true)
  }

  const nextPrePlanMode =
    effectiveTarget === 'plan' && context.mode !== 'plan'
      ? context.mode
      : effectiveTarget !== 'plan'
        ? undefined
        : working.prePlanMode

  return {
    ...working,
    mode: effectiveTarget,
    prePlanMode: nextPrePlanMode,
  }
}

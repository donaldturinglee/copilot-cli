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

/**
 * Splits CLI / frontmatter tool rule entries on commas or whitespace outside
 * balanced parentheses (preserving rules such as `Bash(git status:*)`).
 */
export function parseToolListFromCli(tools: readonly string[]): string[] {
  const result: string[] = []
  for (const raw of tools) {
    let current = ''
    let depth = 0
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!
      if (ch === '(') {
        depth++
        current += ch
      } else if (ch === ')' && depth > 0) {
        depth--
        current += ch
      } else if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
        const trimmed = current.trim()
        if (trimmed) {
          result.push(trimmed)
        }
        current = ''
      } else {
        current += ch
      }
    }
    const trailing = current.trim()
    if (trailing) {
      result.push(trailing)
    }
  }
  return result
}

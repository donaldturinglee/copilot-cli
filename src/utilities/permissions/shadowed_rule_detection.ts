/**
 * Detects permission allow rules that are shadowed/unreachable because of a
 * matching or broader deny/ask rule.
 */

import type {
  PermissionRule,
  ToolPermissionContext,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import {
  isRuleToolNameMatch,
  permissionRuleValueFromString,
} from './permission_rule_parser.js'

export interface ShadowedRuleWarning {
  shadowedRule: PermissionRule
  shadowingRule: PermissionRule
  reason: string
}

/**
 * Finds `allow` rules in `context` that are completely shadowed by a blanket or
 * identical `deny` or `ask` rule.
 */
export function detectShadowedAllowRules(
  context: DeepImmutable<ToolPermissionContext>,
): ShadowedRuleWarning[] {
  const warnings: ShadowedRuleWarning[] = []

  const denyAndAsk: PermissionRule[] = []
  for (const [source, rules] of Object.entries(context.alwaysDenyRules)) {
    for (const raw of rules ?? []) {
      denyAndAsk.push({
        source: source as PermissionRule['source'],
        ruleBehavior: 'deny',
        ruleValue: permissionRuleValueFromString(raw),
      })
    }
  }
  for (const [source, rules] of Object.entries(context.alwaysAskRules)) {
    for (const raw of rules ?? []) {
      denyAndAsk.push({
        source: source as PermissionRule['source'],
        ruleBehavior: 'ask',
        ruleValue: permissionRuleValueFromString(raw),
      })
    }
  }

  for (const [source, rules] of Object.entries(context.alwaysAllowRules)) {
    for (const raw of rules ?? []) {
      const allowRule: PermissionRule = {
        source: source as PermissionRule['source'],
        ruleBehavior: 'allow',
        ruleValue: permissionRuleValueFromString(raw),
      }
      const shadower = denyAndAsk.find(other => {
        const sameTool = isRuleToolNameMatch(other.ruleValue.toolName, {
          name: allowRule.ruleValue.toolName,
        })
        if (!sameTool) return false
        return (
          other.ruleValue.ruleContent === undefined ||
          other.ruleValue.ruleContent === allowRule.ruleValue.ruleContent
        )
      })
      if (shadower) {
        warnings.push({
          shadowedRule: allowRule,
          shadowingRule: shadower,
          reason: `Allow rule '${raw}' is shadowed by ${shadower.ruleBehavior} rule from ${shadower.source}.`,
        })
      }
    }
  }

  return warnings
}

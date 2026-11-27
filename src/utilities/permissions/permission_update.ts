/**
 * Helpers for applying and extracting `PermissionUpdate` deltas against
 * `ToolPermissionContext`.
 */

import type {
  PermissionRule,
  PermissionUpdate,
} from '../../types/permissions.js'
import {
  applyPermissionUpdate,
  applyPermissionUpdates,
  cloneRulesBySource,
} from './rule_matching.js'

export { applyPermissionUpdate, applyPermissionUpdates, cloneRulesBySource }

/**
 * Extracts concrete `PermissionRule` items from a `PermissionUpdate` when it
 * adds or replaces rules.
 */
export function extractRules(update: PermissionUpdate): PermissionRule[] {
  if (update.type !== 'addRules' && update.type !== 'replaceRules') {
    return []
  }
  return update.rules.map(ruleValue => ({
    source: update.destination,
    ruleBehavior: update.behavior,
    ruleValue,
  }))
}

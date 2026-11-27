/**
 * Hook configuration management helpers for listing/updating settings hooks
 * and refreshing the active startup snapshot.
 */

import type { HookMatcher, HooksSettings } from '../../schemas/hooks.js'
import type { HookEvent } from '../../types/hooks.js'
import {
  getHooksConfigFromSnapshot,
  updateHooksConfigSnapshot,
} from './hooks_config_snapshot.js'

export function listConfiguredHooks(
  event?: HookEvent,
): Partial<Record<HookEvent, HookMatcher[]>> {
  const config = getHooksConfigFromSnapshot() ?? {}
  if (event) {
    return config[event] ? { [event]: config[event] } : {}
  }
  return config
}

export function countConfiguredHooks(config?: HooksSettings | null): number {
  const active = config ?? getHooksConfigFromSnapshot() ?? {}
  let total = 0
  for (const matchers of Object.values(active)) {
    if (!matchers) continue
    for (const m of matchers) {
      total += m.hooks.length
    }
  }
  return total
}

export function refreshHooksSnapshot(): void {
  updateHooksConfigSnapshot()
}

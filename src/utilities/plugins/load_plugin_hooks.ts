/**
 * Component Loader #4: Registers 27-event lifecycle hooks (`PluginHookMatcher`)
 * from enabled plugins into `bootstrap/state` (`clearRegisteredPluginHooks` +
 * `registerHookCallbacks`).
 */

import {
  clearRegisteredPluginHooks,
  registerHookCallbacks,
} from '../../bootstrap/state.js'
import type { HookEvent, PluginHookMatcher } from '../../types/forward.js'
import { isHookEvent } from '../../types/hooks.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { loadAllPluginsCacheOnly } from './plugin_loader.js'

/**
 * Loads and registers all lifecycle hooks from enabled plugins, atomically
 * replacing any previously registered plugin hook matchers.
 */
export async function loadPluginHooks(
  pluginsOverride?: readonly LoadedPlugin[],
): Promise<number> {
  clearRegisteredPluginHooks()

  const enabled = pluginsOverride ?? (await loadAllPluginsCacheOnly()).enabled
  const aggregated: Partial<Record<HookEvent, PluginHookMatcher[]>> = {}
  let totalMatchers = 0

  for (const plugin of enabled) {
    if (!plugin.hooksConfig) continue
    for (const [eventName, rawMatchers] of Object.entries(plugin.hooksConfig)) {
      if (!isHookEvent(eventName) || !Array.isArray(rawMatchers)) {
        continue
      }
      const list = aggregated[eventName] ?? []
      for (const raw of rawMatchers) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw as { matcher?: string; hooks?: unknown[] }
        if (!Array.isArray(m.hooks) || m.hooks.length === 0) continue
        list.push({
          matcher: m.matcher,
          hooks: m.hooks,
          pluginRoot: plugin.path,
          pluginName: plugin.name,
          pluginId: plugin.source,
        })
        totalMatchers++
      }
      aggregated[eventName] = list
    }
  }

  if (totalMatchers > 0) {
    registerHookCallbacks(aggregated)
  }
  return totalMatchers
}

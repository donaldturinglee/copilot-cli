/**
 * Built-in first-party plugin registry (`<name>@builtin`).
 */

import type { BuiltinPluginDefinition } from '../types/plugin.js'

const builtinPlugins = new Map<string, BuiltinPluginDefinition>()

/**
 * Registers a built-in plugin definition.
 */
export function registerBuiltinPlugin(def: BuiltinPluginDefinition): void {
  builtinPlugins.set(def.name, def)
}

/**
 * Returns all available built-in plugin definitions.
 */
export function getBuiltinPlugins(): BuiltinPluginDefinition[] {
  return Array.from(builtinPlugins.values()).filter(
    p => p.isAvailable?.() ?? true,
  )
}

/**
 * Clears built-in plugins for isolated unit tests.
 */
export function clearBuiltinPluginsForTesting(): void {
  builtinPlugins.clear()
}

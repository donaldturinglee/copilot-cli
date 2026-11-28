/**
 * Transitive plugin dependency closure resolver (`resolveDependencyClosure`),
 * cross-marketplace trust boundary enforcement (`allowCrossMarketplaceDependenciesOn`
 * — never transitively escalated!), load-time fixed-point demotion
 * (`verifyAndDemote`), and reverse-dependent lookup.
 */

import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import {
  formatPluginIdentifier,
  parsePluginIdentifier,
} from './plugin_identifier.js'

export interface DependencyError {
  pluginId: string
  dependency: string
  reason: 'not-found' | 'cross-marketplace-blocked' | 'cycle'
  message: string
}

export interface DependencyLookupNode {
  dependencies?: readonly string[]
  allowCrossMarketplaceDependenciesOn?: readonly string[]
}

/**
 * Computes the topological dependency installation closure starting from
 * `rootPluginId`, enforcing cycle safety and root-marketplace
 * `allowCrossMarketplaceDependenciesOn` boundaries.
 */
export function resolveDependencyClosure(
  rootPluginId: string,
  lookupPlugin: (pluginId: string) => DependencyLookupNode | null,
  isInstalledAndEnabled?: (pluginId: string) => boolean,
): {
  closure: string[]
  skippedInstalled: string[]
  errors: DependencyError[]
} {
  const rootParsed = parsePluginIdentifier(rootPluginId)
  const rootMarketplace = rootParsed.marketplace ?? ''
  const rootNode = lookupPlugin(rootPluginId)
  const allowedCrossMarketplaces = new Set<string>(
    rootNode?.allowCrossMarketplaceDependenciesOn ?? [],
  )

  const closure: string[] = []
  const skippedInstalled: string[] = []
  const errors: DependencyError[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const dfs = (currentId: string): void => {
    if (visited.has(currentId)) {
      return
    }
    if (visiting.has(currentId)) {
      errors.push({
        pluginId: currentId,
        dependency: currentId,
        reason: 'cycle',
        message: `Circular plugin dependency detected involving "${currentId}"`,
      })
      return
    }

    visiting.add(currentId)
    const currentParsed = parsePluginIdentifier(currentId)
    const currentMp = currentParsed.marketplace ?? rootMarketplace
    const node = lookupPlugin(currentId)

    if (!node) {
      errors.push({
        pluginId: currentId,
        dependency: currentId,
        reason: 'not-found',
        message: `Plugin "${currentId}" not found in marketplace "${currentMp}"`,
      })
      visiting.delete(currentId)
      return
    }

    for (const rawDep of node.dependencies ?? []) {
      const parsedDep = parsePluginIdentifier(String(rawDep))
      const depMarketplace = parsedDep.marketplace ?? currentMp
      const qualifiedDep = depMarketplace
        ? formatPluginIdentifier(parsedDep.name, depMarketplace)
        : parsedDep.name

      // Enforce root marketplace's cross-marketplace trust boundary (no transitive escalation)
      if (
        rootMarketplace &&
        depMarketplace !== rootMarketplace &&
        !allowedCrossMarketplaces.has(depMarketplace)
      ) {
        errors.push({
          pluginId: currentId,
          dependency: qualifiedDep,
          reason: 'cross-marketplace-blocked',
          message: `Cross-marketplace dependency "${qualifiedDep}" required by "${currentId}" is not permitted by root marketplace "${rootMarketplace}"`,
        })
        continue
      }

      if (currentId !== rootPluginId && isInstalledAndEnabled?.(qualifiedDep)) {
        if (!skippedInstalled.includes(qualifiedDep)) {
          skippedInstalled.push(qualifiedDep)
        }
        visited.add(qualifiedDep)
        continue
      }

      dfs(qualifiedDep)
    }

    visiting.delete(currentId)
    visited.add(currentId)

    if (currentId !== rootPluginId && isInstalledAndEnabled?.(currentId)) {
      if (!skippedInstalled.includes(currentId)) {
        skippedInstalled.push(currentId)
      }
    } else {
      closure.push(currentId)
    }
  }

  dfs(rootPluginId)
  return { closure, skippedInstalled, errors }
}

/**
 * Runs a fixed-point pass demoting any enabled plugin whose declared
 * dependencies are missing or disabled, cascading to reverse dependents.
 */
export function verifyAndDemote(
  enabled: LoadedPlugin[],
  disabled: LoadedPlugin[],
  errors: PluginError[],
): { enabled: LoadedPlugin[]; disabled: LoadedPlugin[] } {
  const active = [...enabled]
  const inactive = [...disabled]
  const disabledIds = new Set(inactive.map(p => p.source))
  const inlineBareNames = new Set(
    active
      .filter(p => p.source.endsWith('@inline'))
      .map(p => p.name),
  )

  let changed = true
  while (changed) {
    changed = false
    const activeIds = new Set(active.map(p => p.source))

    for (let i = active.length - 1; i >= 0; i--) {
      const plugin = active[i]!
      const deps = (plugin.manifest.dependencies ?? []).map(d => String(d))
      if (deps.length === 0) {
        continue
      }
      const ownMp = parsePluginIdentifier(plugin.source).marketplace ?? ''

      let unsatisfiedDep: { id: string; reason: 'not-enabled' | 'not-found' } | null =
        null
      for (const rawDep of deps) {
        const parsed = parsePluginIdentifier(rawDep)
        const depId = parsed.marketplace
          ? formatPluginIdentifier(parsed.name, parsed.marketplace)
          : ownMp
            ? formatPluginIdentifier(parsed.name, ownMp)
            : parsed.name

        if (activeIds.has(depId) || (!parsed.marketplace && inlineBareNames.has(parsed.name))) {
          continue
        }
        unsatisfiedDep = {
          id: depId,
          reason: disabledIds.has(depId) ? 'not-enabled' : 'not-found',
        }
        break
      }

      if (unsatisfiedDep) {
        active.splice(i, 1)
        const demoted: LoadedPlugin = { ...plugin, enabled: false }
        inactive.push(demoted)
        disabledIds.add(plugin.source)
        errors.push({
          type: 'dependency-unsatisfied',
          source: plugin.source,
          plugin: plugin.name,
          dependency: unsatisfiedDep.id,
          reason: unsatisfiedDep.reason,
        })
        changed = true
      }
    }
  }

  return { enabled: active, disabled: inactive }
}

/**
 * Finds enabled plugins that depend on `targetPluginId` (used for non-blocking
 * warnings during disable/uninstall).
 */
export function findReverseDependents(
  targetPluginId: string,
  enabledPlugins: readonly LoadedPlugin[],
): string[] {
  const targetParsed = parsePluginIdentifier(targetPluginId)
  const dependents: string[] = []

  for (const plugin of enabledPlugins) {
    if (plugin.source === targetPluginId) continue
    const ownMp = parsePluginIdentifier(plugin.source).marketplace ?? ''
    for (const rawDep of plugin.manifest.dependencies ?? []) {
      const parsed = parsePluginIdentifier(String(rawDep))
      const depId = parsed.marketplace
        ? formatPluginIdentifier(parsed.name, parsed.marketplace)
        : ownMp
          ? formatPluginIdentifier(parsed.name, ownMp)
          : parsed.name
      if (
        depId === targetPluginId ||
        (!parsed.marketplace && parsed.name === targetParsed.name)
      ) {
        dependents.push(plugin.source)
        break
      }
    }
  }

  return dependents
}

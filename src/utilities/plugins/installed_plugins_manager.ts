/**
 * Manages `installed_plugins.json` (v2 physical installation registry),
 * strictly separated from `settings.enabledPlugins` (user/project/policy intent).
 *
 * Preserves an in-memory startup snapshot so background plugin updates do not
 * mutate paths beneath an active session until `/reload-plugins` or restart.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { getCwd } from '../cwd.js'
import { getInstalledPluginsFilePath } from './plugin_directories.js'
import {
  InstalledPluginsFileSchemaV2,
  type InstalledPluginsFileV2,
  type PersistablePluginScope,
  type PluginInstallationEntry,
} from './schemas.js'

let frozenSnapshot: InstalledPluginsFileV2 | null = null

function readInstalledPluginsFromDisk(): InstalledPluginsFileV2 {
  const path = getInstalledPluginsFilePath()
  if (!existsSync(path)) {
    return { version: 2, plugins: {} }
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const v2 = InstalledPluginsFileSchemaV2().safeParse(raw)
    if (v2.success) {
      return v2.data
    }

    // Auto-migrate legacy v1 `{ plugins: { [id]: { installPath, version, ... } } }`
    if (
      raw &&
      typeof raw === 'object' &&
      'plugins' in raw &&
      (raw as { plugins?: unknown }).plugins &&
      typeof (raw as { plugins: unknown }).plugins === 'object'
    ) {
      const migrated: Record<string, PluginInstallationEntry[]> = {}
      for (const [id, entry] of Object.entries(
        (raw as { plugins: Record<string, unknown> }).plugins,
      )) {
        if (Array.isArray(entry)) {
          migrated[id] = entry as PluginInstallationEntry[]
        } else if (entry && typeof entry === 'object') {
          const legacy = entry as Record<string, unknown>
          if (typeof legacy.installPath === 'string') {
            migrated[id] = [
              {
                scope: 'user',
                installPath: legacy.installPath,
                version:
                  typeof legacy.version === 'string'
                    ? legacy.version
                    : undefined,
                installedAt:
                  typeof legacy.installedAt === 'string'
                    ? legacy.installedAt
                    : new Date().toISOString(),
              },
            ]
          }
        }
      }
      return { version: 2, plugins: migrated }
    }
  } catch {
    // Fall back to empty v2 structure
  }
  return { version: 2, plugins: {} }
}

function writeInstalledPluginsToDisk(data: InstalledPluginsFileV2): void {
  const filePath = getInstalledPluginsFilePath()
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(tmpPath, filePath)
}

/**
 * Returns the active v2 installed plugins map (reading from the in-memory
 * snapshot once initialized, or directly from disk when `bypassSnapshot` is true).
 */
export function getInstalledPluginsV2(
  bypassSnapshot = false,
): InstalledPluginsFileV2 {
  if (bypassSnapshot) {
    return readInstalledPluginsFromDisk()
  }
  if (!frozenSnapshot) {
    frozenSnapshot = readInstalledPluginsFromDisk()
  }
  return frozenSnapshot
}

/**
 * Refreshes the in-memory `installed_plugins.json` snapshot from disk (called
 * on `/reload-plugins` and explicit foreground CLI install/uninstall commands).
 */
export function refreshInstalledPluginsSnapshot(): InstalledPluginsFileV2 {
  frozenSnapshot = readInstalledPluginsFromDisk()
  return frozenSnapshot
}

/**
 * Marks a superseded plugin cache directory as orphaned with `.orphaned_at`
 * so background GC can clean it up after 7 days without breaking active sessions.
 */
export function markPluginVersionOrphaned(installPath: string): void {
  if (!existsSync(installPath)) {
    return
  }
  try {
    writeFileSync(
      join(installPath, '.orphaned_at'),
      new Date().toISOString(),
      'utf8',
    )
  } catch {
    // Ignore read-only cache directories
  }
}

/**
 * Registers or updates a plugin installation entry in `installed_plugins.json`.
 * When `updateMemorySnapshot` is `false` (background update), only disk is
 * updated so the running session keeps its startup `installPath`.
 */
export function recordInstalledPlugin(
  pluginId: string,
  entry: PluginInstallationEntry,
  options?: { updateMemorySnapshot?: boolean },
): void {
  const disk = readInstalledPluginsFromDisk()
  const existingList = disk.plugins[pluginId] ?? []
  const normProject = entry.projectPath ? resolve(entry.projectPath) : undefined

  const filtered: PluginInstallationEntry[] = []
  for (const prev of existingList) {
    const sameScope =
      prev.scope === entry.scope &&
      (prev.projectPath ? resolve(prev.projectPath) : undefined) === normProject
    if (sameScope) {
      if (prev.installPath !== entry.installPath) {
        markPluginVersionOrphaned(prev.installPath)
      }
      continue
    }
    filtered.push(prev)
  }

  filtered.push({
    ...entry,
    ...(normProject ? { projectPath: normProject } : {}),
  })
  disk.plugins[pluginId] = filtered
  writeInstalledPluginsToDisk(disk)

  if (options?.updateMemorySnapshot !== false) {
    frozenSnapshot = disk
  }
}

/**
 * Removes an installation entry for `(pluginId, scope, projectPath)` from
 * `installed_plugins.json`. Returns the remaining scope entries for `pluginId`.
 */
export function removeInstalledPluginEntry(
  pluginId: string,
  scope: PersistablePluginScope,
  projectPath?: string,
): { removed: boolean; remainingEntries: PluginInstallationEntry[] } {
  const disk = readInstalledPluginsFromDisk()
  const existing = disk.plugins[pluginId]
  if (!existing || existing.length === 0) {
    return { removed: false, remainingEntries: [] }
  }

  const normProject = projectPath ? resolve(projectPath) : undefined
  const kept: PluginInstallationEntry[] = []
  let removed = false

  for (const item of existing) {
    const itemProj = item.projectPath ? resolve(item.projectPath) : undefined
    const matches =
      item.scope === scope &&
      (scope === 'user' ||
      scope === 'managed' ||
      !normProject
        ? true
        : itemProj === normProject)
    if (matches) {
      removed = true
      markPluginVersionOrphaned(item.installPath)
    } else {
      kept.push(item)
    }
  }

  if (kept.length > 0) {
    disk.plugins[pluginId] = kept
  } else {
    delete disk.plugins[pluginId]
  }
  writeInstalledPluginsToDisk(disk)
  frozenSnapshot = disk

  return { removed, remainingEntries: kept }
}

/**
 * Resolves the highest-precedence installed entry (`managed > local > project > user`)
 * for `pluginId` in `cwd`.
 */
export function resolveInstalledPluginEntry(
  pluginId: string,
  cwd: string = getCwd(),
): PluginInstallationEntry | undefined {
  const all = getInstalledPluginsV2().plugins[pluginId]
  if (!all || all.length === 0) {
    return undefined
  }
  const normCwd = resolve(cwd)
  const priorityOrder: readonly PersistablePluginScope[] = [
    'managed',
    'local',
    'project',
    'user',
  ]
  for (const scope of priorityOrder) {
    const found = all.find(e => {
      if (e.scope !== scope) return false
      if (scope === 'project' || scope === 'local') {
        return !e.projectPath || resolve(e.projectPath) === normCwd
      }
      return true
    })
    if (found) {
      return found
    }
  }
  return all[0]
}

/**
 * Delisted / flagged plugin persistence (`flagged-plugins.json`) for
 * marketplaces enforcing `forceRemoveDeletedPlugins`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { getFlaggedPluginsFilePath } from './plugin_directories.js'

export interface FlaggedPluginEntry {
  id: string
  name: string
  marketplace: string
  reason: string
  flaggedAt: string
  seenAt?: string
}

const SEEN_PURGE_MS = 48 * 3600 * 1000

/**
 * Reads active flagged plugin notifications, pruning entries seen >48h ago.
 */
export function getFlaggedPlugins(): FlaggedPluginEntry[] {
  const path = getFlaggedPluginsFilePath()
  if (!existsSync(path)) {
    return []
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as FlaggedPluginEntry[]
    if (!Array.isArray(raw)) {
      return []
    }
    const now = Date.now()
    return raw.filter(item => {
      if (!item.seenAt) return true
      return now - Date.parse(item.seenAt) < SEEN_PURGE_MS
    })
  } catch {
    return []
  }
}

/**
 * Records a delisted plugin removal in `flagged-plugins.json`.
 */
export function recordFlaggedPlugin(entry: FlaggedPluginEntry): void {
  const path = getFlaggedPluginsFilePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const existing = getFlaggedPlugins().filter(e => e.id !== entry.id)
  existing.push(entry)
  writeFileSync(path, JSON.stringify(existing, null, 2), { mode: 0o600 })
}

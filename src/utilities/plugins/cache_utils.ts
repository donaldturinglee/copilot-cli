/**
 * Garbage collection for orphaned plugin version directories (`.orphaned_at`
 * older than 7 days) and ripgrep exclusion patterns.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getPluginCacheRoot } from './plugin_directories.js'

const ORPHAN_RETENTION_MS = 7 * 24 * 3600 * 1000

/**
 * Sweeps `~/.copilot/plugins/cache/` in the background and deletes version
 * directories whose `.orphaned_at` marker is older than 7 days.
 */
export function cleanupOrphanedPluginVersionsInBackground(): void {
  const root = getPluginCacheRoot()
  if (!existsSync(root)) {
    return
  }

  setImmediate(() => {
    try {
      const now = Date.now()
      for (const mpEntry of readdirSync(root, { withFileTypes: true })) {
        if (!mpEntry.isDirectory()) continue
        const mpPath = join(root, mpEntry.name)
        for (const plugEntry of readdirSync(mpPath, { withFileTypes: true })) {
          if (!plugEntry.isDirectory()) continue
          const plugPath = join(mpPath, plugEntry.name)
          for (const verEntry of readdirSync(plugPath, { withFileTypes: true })) {
            if (!verEntry.isDirectory()) continue
            const verPath = join(plugPath, verEntry.name)
            const marker = join(verPath, '.orphaned_at')
            if (!existsSync(marker)) continue
            const ts = Date.parse(readFileSync(marker, 'utf8').trim())
            if (Number.isFinite(ts) && now - ts >= ORPHAN_RETENTION_MS) {
              rmSync(verPath, { recursive: true, force: true })
            }
          }
        }
      }
    } catch {
      // Non-fatal background sweep
    }
  })
}

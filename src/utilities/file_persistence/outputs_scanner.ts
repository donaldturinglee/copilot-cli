/**
 * Symlink-safe recursive scanner detecting regular files modified during the
 * current turn under `{cwd}/{sessionId}/outputs/`.
 */

import { lstat, readdir } from 'fs/promises'
import { join } from 'path'
import type { TurnStartTime } from './types.js'

export type EnvironmentKind = 'byoc' | 'anthropic_cloud' | null

/**
 * Returns the active remote execution environment kind, or `null` locally.
 */
export function getEnvironmentKind(): EnvironmentKind {
  const raw = process.env.COPILOT_CLI_ENVIRONMENT_KIND
  if (raw === 'byoc' || raw === 'anthropic_cloud') {
    return raw
  }
  return null
}

/**
 * Recursively scans `outputsDir` for regular files with `mtimeMs >= turnStartTime`,
 * rejecting symlinks at both `readdir` and `lstat` (TOCTOU protection).
 */
export async function findModifiedFiles(
  turnStartTime: TurnStartTime,
  outputsDir: string,
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(outputsDir, {
      withFileTypes: true,
      recursive: true,
    })
  } catch {
    return []
  }

  const results: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      continue
    }
    const parent =
      (entry as { parentPath?: string; path?: string }).parentPath ??
      (entry as { path?: string }).path ??
      outputsDir
    const fullPath = join(parent, entry.name)
    try {
      const info = await lstat(fullPath)
      if (info.isSymbolicLink() || !info.isFile()) {
        continue
      }
      if (info.mtimeMs >= turnStartTime) {
        results.push(fullPath)
      }
    } catch {
      // File disappeared or became unreadable
    }
  }

  return results
}

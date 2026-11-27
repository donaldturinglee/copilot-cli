/**
 * Portable worktree path resolution under `<repoRoot>/.copilot/worktrees/`.
 */

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

export function getWorktreesDirectory(repoRoot: string): string {
  return join(repoRoot, '.copilot', 'worktrees')
}

export function getWorktreePath(repoRoot: string, slug: string): string {
  return join(getWorktreesDirectory(repoRoot), slug)
}

export function listExistingWorktreePaths(repoRoot: string): string[] {
  const dir = getWorktreesDirectory(repoRoot)
  if (!existsSync(dir)) {
    return []
  }
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(dir, entry.name))
  } catch {
    return []
  }
}

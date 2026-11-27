/**
 * Worktree path resolution helper using the active canonical git root.
 */

import { findCanonicalGitRoot } from './git.js'
import {
  getWorktreePath,
  getWorktreesDirectory,
  listExistingWorktreePaths,
} from './get_worktree_paths_portable.js'

export { getWorktreePath, getWorktreesDirectory, listExistingWorktreePaths }

export function getActiveRepoWorktreePaths(cwd?: string): string[] {
  const root = findCanonicalGitRoot(cwd)
  if (!root) return []
  return listExistingWorktreePaths(root)
}

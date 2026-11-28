/**
 * Git repository detection helper for memory scope checks.
 */

import { findGitRoot } from '../git.js'

/**
 * Returns `true` if `cwd` resides inside a git repository.
 */
export function projectIsInGitRepo(cwd: string): boolean {
  return findGitRoot(cwd) !== null
}

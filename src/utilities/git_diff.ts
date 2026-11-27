/**
 * Single-file git diff helper for attribution and post-edit inspection.
 */

import { execFileNoThrowWithCwd } from './exec_file_no_throw.js'
import { findGitRoot, gitExe } from './git.js'

export interface ToolUseDiff {
  filePath: string
  diff: string
  isUntracked: boolean
}

/**
 * Fetches the `git diff` output for a single file relative to HEAD/index.
 */
export async function fetchSingleFileGitDiff(
  filePath: string,
  cwd?: string,
): Promise<ToolUseDiff | null> {
  const root = findGitRoot(cwd)
  if (!root) {
    return null
  }
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'diff', '--', filePath],
    { cwd: root },
  )
  if (result.code !== 0) {
    return null
  }
  return {
    filePath,
    diff: result.stdout,
    isUntracked: result.stdout.trim().length === 0,
  }
}

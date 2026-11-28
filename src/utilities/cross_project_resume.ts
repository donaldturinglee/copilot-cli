/**
 * Cross-project resume helper detecting when a selected session lives in
 * another project directory (or same-repo worktree) and formatting a copyable
 * `cd <dir> && copilot --resume <id>` command.
 */

import { sep } from 'path'
import { getOriginalCwd } from '../bootstrap/state.js'
import type { LogOption } from '../types/logs.js'
import { quote as shellQuote } from './bash/shell_quote.js'

export type CrossProjectResumeResult =
  | { isCrossProject: false }
  | {
      isCrossProject: true
      isSameRepoWorktree: true
      projectPath: string
    }
  | {
      isCrossProject: true
      isSameRepoWorktree: false
      projectPath: string
      command: string
    }

/**
 * Checks whether resuming `log` requires changing working directories.
 */
export function checkCrossProjectResume(
  log: Pick<LogOption, 'projectPath' | 'sessionId'>,
  showAllProjects: boolean,
  worktreePaths: readonly string[] = [],
): CrossProjectResumeResult {
  if (!showAllProjects || !log.projectPath) {
    return { isCrossProject: false }
  }

  const currentCwd = getOriginalCwd()
  if (log.projectPath === currentCwd) {
    return { isCrossProject: false }
  }

  const isSameRepoWorktree = worktreePaths.some(
    wt => log.projectPath === wt || log.projectPath!.startsWith(`${wt}${sep}`),
  )

  if (isSameRepoWorktree) {
    return {
      isCrossProject: true,
      isSameRepoWorktree: true,
      projectPath: log.projectPath,
    }
  }

  const sid = log.sessionId ?? ''
  const quotedDir = shellQuote([log.projectPath])
  return {
    isCrossProject: true,
    isSameRepoWorktree: false,
    projectPath: log.projectPath,
    command: `cd ${quotedDir} && copilot --resume ${sid}`,
  }
}

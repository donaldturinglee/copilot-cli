/**
 * Session context assembly:
 * - `getSystemContext()`: 5 parallel git snapshot operations (branch, mainBranch,
 *   short status truncated at 2k chars, recent 5 commits, git user.name).
 * - `getUserContext()`: layered `CLAUDE.md` content + local calendar date.
 */

import memoize from 'lodash-es/memoize.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  setCachedClaudeMdContent,
} from './bootstrap/state.js'
import { getLocalIsoDate } from './constants/common.js'
import {
  filterInjectedMemoryFiles,
  getClaudeMds,
  getMemoryFiles,
} from './utilities/claudemd.js'
import { getCwd } from './utilities/cwd.js'
import { isBareMode, isEnvTruthy } from './utilities/env_utils.js'
import { execFileNoThrowWithCwd } from './utilities/exec_file_no_throw.js'
import {
  getBranch,
  getDefaultBranch,
  getIsGit,
  gitExe,
} from './utilities/git.js'
import { shouldIncludeGitInstructions } from './utilities/git_settings.js'

const MAX_STATUS_CHARS = 2_000

/**
 * Runs 5 parallel git snapshot probes (`branch`, `defaultBranch`, `status`,
 * `log`, `user.name`) and formats them for the system context.
 */
export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    return null
  }
  const cwd = getCwd()
  if (!(await getIsGit(cwd))) {
    return null
  }

  const git = gitExe()
  const [branch, mainBranch, statusRes, logRes, userRes] = await Promise.all([
    getBranch(cwd),
    getDefaultBranch(cwd),
    execFileNoThrowWithCwd(git, ['--no-optional-locks', 'status', '--short'], {
      cwd,
    }),
    execFileNoThrowWithCwd(
      git,
      ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
      { cwd },
    ),
    execFileNoThrowWithCwd(git, ['config', 'user.name'], { cwd }),
  ])

  const rawStatus = statusRes.code === 0 ? statusRes.stdout.trim() : ''
  const truncatedStatus =
    rawStatus.length > MAX_STATUS_CHARS
      ? `${rawStatus.slice(0, MAX_STATUS_CHARS)}\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using BashTool)`
      : rawStatus
  const logText = logRes.code === 0 ? logRes.stdout.trim() : ''
  const userName = userRes.code === 0 ? userRes.stdout.trim() : ''

  const sections: string[] = [
    'This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
    `Current branch: ${branch || '(unknown)'}`,
    `Main branch (you will usually use this for PRs): ${mainBranch || 'main'}`,
  ]
  if (userName) {
    sections.push(`Git user: ${userName}`)
  }
  sections.push(`Status:\n${truncatedStatus || '(clean)'}`)
  if (logText) {
    sections.push(`Recent commits:\n${logText}`)
  }
  return sections.join('\n\n')
})

/**
 * Assembles system-level dynamic context (git status snapshot).
 */
export const getSystemContext = memoize(
  async (): Promise<Record<string, string>> => {
    const context: Record<string, string> = {}
    if (
      !isEnvTruthy(process.env.COPILOT_CLI_REMOTE) &&
      shouldIncludeGitInstructions()
    ) {
      const gitStatus = await getGitStatus()
      if (gitStatus) {
        context.gitStatus = gitStatus
      }
    }
    return context
  },
)

/**
 * Assembles user-level context (layered `CLAUDE.md` instructions + local date).
 */
export const getUserContext = memoize(
  async (): Promise<Record<string, string>> => {
    const disableClaudeMd =
      isEnvTruthy(process.env.COPILOT_CLI_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)

    let claudeMd = ''
    if (!disableClaudeMd) {
      const memoryFiles = await getMemoryFiles()
      claudeMd = getClaudeMds(filterInjectedMemoryFiles(memoryFiles))
      setCachedClaudeMdContent(claudeMd || null)
    } else {
      setCachedClaudeMdContent(null)
    }

    return {
      ...(claudeMd ? { claudeMd } : {}),
      currentDate: `Today's date is ${getLocalIsoDate()}.`,
    }
  },
)

/**
 * Clears memoized git, system, and user context caches (used on `/clear`, `/compact`, tests).
 */
export function clearContextCaches(): void {
  getGitStatus.cache.clear?.()
  getSystemContext.cache.clear?.()
  getUserContext.cache.clear?.()
}

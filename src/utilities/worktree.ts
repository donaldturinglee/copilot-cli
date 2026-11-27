/**
 * Isolated Git worktree lifecycle management:
 * - `validateWorktreeSlug()`: strict path-traversal & git-ref defense
 * - `createWorktreeForSession()`: creates `.copilot/worktrees/<slug>` on
 *   branch `worktree-<slug>` and switches CWD into the worktree
 * - `hasWorktreeChanges()`: detects uncommitted files and unmerged commits
 * - `keepWorktree()` / `cleanupWorktree()`: safe session exit with fail-closed
 *   dirty-worktree protection unless `discardChanges: true`
 */

import { randomBytes } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { setCwdState } from '../bootstrap/state.js'
import { getCwd } from './cwd.js'
import { execFileNoThrowWithCwd } from './exec_file_no_throw.js'
import { getWorktreePath, getWorktreesDirectory } from './get_worktree_paths_portable.js'
import { findCanonicalGitRoot, gitExe } from './git.js'

export interface WorktreeSession {
  originalCwd: string
  originalBranch?: string
  originalHeadCommit?: string
  repoRoot: string
  worktreePath: string
  worktreeBranch: string
  worktreeName: string
  createdAt: number
}

const VALID_WORKTREE_SLUG_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

let currentWorktreeSession: WorktreeSession | null = null

/**
 * Validates a worktree slug against path traversal (`..`, `/`, `\`), leading
 * dots/dashes, git lock suffixes, and control characters.
 */
export function validateWorktreeSlug(slug: string): {
  valid: boolean
  error?: string
} {
  const trimmed = slug.trim()
  if (!trimmed) {
    return { valid: false, error: 'Worktree name must not be empty.' }
  }
  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    return {
      valid: false,
      error: `Invalid worktree name "${slug}": path separators and ".." are not allowed.`,
    }
  }
  if (trimmed.endsWith('.lock') || trimmed.endsWith('.')) {
    return {
      valid: false,
      error: `Invalid worktree name "${slug}": cannot end with "." or ".lock".`,
    }
  }
  if (!VALID_WORKTREE_SLUG_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: `Invalid worktree name "${slug}": must start with an alphanumeric character and contain only letters, numbers, ".", "_", or "-" (max 64 chars).`,
    }
  }
  return { valid: true }
}

/**
 * Derives the git branch name for a worktree slug.
 */
export function worktreeBranchName(slug: string): string {
  return `worktree-${slug}`
}

export function getCurrentWorktreeSession(): WorktreeSession | null {
  return currentWorktreeSession
}

export function restoreWorktreeSession(session: WorktreeSession | null): void {
  currentWorktreeSession = session
}

function generateDefaultSlug(): string {
  return `session-${randomBytes(4).toString('hex')}`
}

/**
 * Creates a new isolated git worktree under `<repoRoot>/.copilot/worktrees/<slug>`
 * and switches the active working directory into it.
 */
export async function createWorktreeForSession(
  requestedName?: string,
  cwd: string = getCwd(),
): Promise<WorktreeSession> {
  const slug = requestedName?.trim() || generateDefaultSlug()
  const validation = validateWorktreeSlug(slug)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  const repoRoot = findCanonicalGitRoot(cwd)
  if (!repoRoot) {
    throw new Error(
      `Cannot create git worktree: "${cwd}" is not inside a git repository.`,
    )
  }

  const headRes = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-parse', 'HEAD'],
    { cwd: repoRoot },
  )
  const originalHeadCommit =
    headRes.code === 0 ? headRes.stdout.trim() : undefined
  if (!originalHeadCommit) {
    throw new Error(
      'Cannot create git worktree: repository has no commits (HEAD is unborn).',
    )
  }

  const branchRes = await execFileNoThrowWithCwd(
    gitExe(),
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: repoRoot },
  )
  const originalBranch =
    branchRes.code === 0 ? branchRes.stdout.trim() : undefined

  const worktreesDir = getWorktreesDirectory(repoRoot)
  mkdirSync(worktreesDir, { recursive: true })

  const worktreePath = getWorktreePath(repoRoot, slug)
  const branch = worktreeBranchName(slug)

  if (existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`)
  }

  mkdirSync(dirname(worktreePath), { recursive: true })
  const addRes = await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'add', '-b', branch, worktreePath, originalHeadCommit],
    { cwd: repoRoot },
  )
  if (addRes.code !== 0) {
    throw new Error(
      `Failed to create git worktree: ${addRes.stderr.trim() || addRes.stdout.trim()}`,
    )
  }

  const session: WorktreeSession = {
    originalCwd: cwd,
    originalBranch,
    originalHeadCommit,
    repoRoot,
    worktreePath,
    worktreeBranch: branch,
    worktreeName: slug,
    createdAt: Date.now(),
  }

  currentWorktreeSession = session
  setCwdState(worktreePath)
  return session
}

/**
 * Checks whether a worktree has uncommitted files (staged, unstaged, or
 * untracked) or unmerged commits relative to its base commit.
 */
export async function checkWorktreeChanges(
  session: WorktreeSession,
): Promise<{
  uncommittedFiles: number
  unmergedCommits: number
  hasChanges: boolean
}> {
  const statusRes = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    { cwd: session.worktreePath },
  )
  const uncommittedFiles =
    statusRes.code === 0
      ? statusRes.stdout
          .split(/\r?\n/)
          .filter(line => line.trim().length > 0).length
      : 0

  let unmergedCommits = 0
  if (session.originalHeadCommit) {
    const revListRes = await execFileNoThrowWithCwd(
      gitExe(),
      ['rev-list', '--count', `${session.originalHeadCommit}..HEAD`],
      { cwd: session.worktreePath },
    )
    if (revListRes.code === 0) {
      unmergedCommits = Number.parseInt(revListRes.stdout.trim(), 10) || 0
    }
  }

  return {
    uncommittedFiles,
    unmergedCommits,
    hasChanges: uncommittedFiles > 0 || unmergedCommits > 0,
  }
}

/**
 * Exits the active worktree session, restoring `originalCwd` while leaving the
 * worktree directory and branch intact.
 */
export function keepWorktree(): WorktreeSession {
  const session = currentWorktreeSession
  if (!session) {
    throw new Error('No active worktree session to exit.')
  }
  setCwdState(session.originalCwd)
  currentWorktreeSession = null
  return session
}

/**
 * Removes the active worktree directory and deletes its branch, restoring
 * `originalCwd`. Fails closed if uncommitted files or unmerged commits exist
 * unless `options.discardChanges === true`.
 */
export async function cleanupWorktree(options?: {
  discardChanges?: boolean
}): Promise<{
  session: WorktreeSession
  discardedFiles: number
  discardedCommits: number
}> {
  const session = currentWorktreeSession
  if (!session) {
    throw new Error('No active worktree session to clean up.')
  }

  const changes = await checkWorktreeChanges(session)
  if (changes.hasChanges && !options?.discardChanges) {
    throw new Error(
      `Worktree "${session.worktreeName}" has ${changes.uncommittedFiles} uncommitted file(s) and ${changes.unmergedCommits} unmerged commit(s). Re-run with discard_changes: true to confirm deletion, or use action: "keep".`,
    )
  }

  // Switch CWD back before removing directory (required on Windows to release folder lock)
  setCwdState(session.originalCwd)

  const removeArgs = ['worktree', 'remove', '--force', session.worktreePath]
  const removeRes = await execFileNoThrowWithCwd(gitExe(), removeArgs, {
    cwd: session.repoRoot,
  })
  if (removeRes.code !== 0) {
    throw new Error(
      `Failed to remove worktree ${session.worktreePath}: ${removeRes.stderr.trim() || removeRes.stdout.trim()}`,
    )
  }

  await execFileNoThrowWithCwd(
    gitExe(),
    ['branch', '-D', session.worktreeBranch],
    { cwd: session.repoRoot },
  )

  currentWorktreeSession = null
  return {
    session,
    discardedFiles: changes.uncommittedFiles,
    discardedCommits: changes.unmergedCommits,
  }
}

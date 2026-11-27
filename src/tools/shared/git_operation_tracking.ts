/**
 * Git operation detection and telemetry tracking for shell commands
 * (`git commit`, `git push`, `git merge`, `git rebase`, `gh pr ...`).
 */

import { getCommitCounter, getPrCounter } from '../../bootstrap/state.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../../services/analytics/index.js'
import type { BranchAction, CommitKind, PrAction } from '../../types/forward.js'

export interface DetectedGitOperation {
  commits: Array<{ sha: string; kind: CommitKind }>
  pushes: Array<{ branch: string }>
  branches: Array<{ ref: string; action: BranchAction }>
  prs: Array<{ number: number; url?: string; action: PrAction }>
}

/**
 * Extracts a short commit SHA from `git commit` stdout (e.g. `[main abc1234] msg`).
 */
export function parseGitCommitId(stdout: string): string | undefined {
  const match = stdout.match(/\[[^\]]+\s+([0-9a-f]{7,40})\]/i)
  return match?.[1]
}

/**
 * Inspects a shell command and its stdout to identify git commit, push,
 * branch merge/rebase, and GitHub CLI PR operations.
 */
export function detectGitOperation(
  command: string,
  stdout: string,
): DetectedGitOperation {
  const result: DetectedGitOperation = {
    commits: [],
    pushes: [],
    branches: [],
    prs: [],
  }

  const trimmed = command.trim()

  // git commit / amend
  if (/\bgit\b[^;&|]*\bcommit\b/.test(trimmed)) {
    const sha = parseGitCommitId(stdout) ?? 'unknown'
    const kind: CommitKind = /\s--amend\b/.test(trimmed)
      ? 'amended'
      : 'committed'
    result.commits.push({ sha, kind })
  }

  // git cherry-pick
  if (/\bgit\b[^;&|]*\bcherry-pick\b/.test(trimmed)) {
    const sha = parseGitCommitId(stdout) ?? 'unknown'
    result.commits.push({ sha, kind: 'cherry-picked' })
  }

  // git push
  const pushMatch = trimmed.match(
    /\bgit\b[^;&|]*\bpush\b(?:\s+-[^\s]+)*\s+(?:[^\s]+\s+)?([^\s;&|]+)/,
  )
  if (/\bgit\b[^;&|]*\bpush\b/.test(trimmed)) {
    result.pushes.push({ branch: pushMatch?.[1] ?? 'HEAD' })
  }

  // git merge / rebase
  const mergeMatch = trimmed.match(
    /\bgit\b[^;&|]*\bmerge\b(?:\s+-[^\s]+)*\s+([^\s;&|]+)/,
  )
  if (mergeMatch?.[1]) {
    result.branches.push({ ref: mergeMatch[1], action: 'merged' })
  }
  const rebaseMatch = trimmed.match(
    /\bgit\b[^;&|]*\brebase\b(?:\s+-[^\s]+)*\s+([^\s;&|]+)/,
  )
  if (rebaseMatch?.[1]) {
    result.branches.push({ ref: rebaseMatch[1], action: 'rebased' })
  }

  // gh pr <action>
  const prMatch = trimmed.match(
    /\bgh\s+pr\s+(create|edit|merge|comment|close|ready)\b/,
  )
  if (prMatch?.[1]) {
    const actionMap: Record<string, PrAction> = {
      create: 'created',
      edit: 'edited',
      merge: 'merged',
      comment: 'commented',
      close: 'closed',
      ready: 'ready',
    }
    const action = actionMap[prMatch[1]]
    const urlMatch = stdout.match(/https?:\/\/[^\s]+\/pull\/(\d+)/)
    const prNumber = urlMatch?.[1] ? Number.parseInt(urlMatch[1], 10) : 0
    if (action) {
      result.prs.push({
        number: prNumber,
        ...(urlMatch?.[0] ? { url: urlMatch[0] } : {}),
        action,
      })
    }
  }

  return result
}

/**
 * Records OTel counters and analytics events for successful git operations
 * detected from a shell tool execution.
 */
export function trackGitOperations(
  command: string,
  exitCode: number,
  stdout: string,
): DetectedGitOperation {
  if (exitCode !== 0) {
    return { commits: [], pushes: [], branches: [], prs: [] }
  }
  const detected = detectGitOperation(command, stdout)
  if (detected.commits.length > 0) {
    getCommitCounter()?.add(detected.commits.length)
    logEvent('tengu_git_operation', {
      operation: 'commit' as VerifiedNonSensitiveAnalyticsMetadata,
      count: detected.commits.length,
    })
  }
  if (detected.prs.length > 0) {
    getPrCounter()?.add(detected.prs.length)
    logEvent('tengu_git_operation', {
      operation: 'pr' as VerifiedNonSensitiveAnalyticsMetadata,
      count: detected.prs.length,
    })
  }
  return detected
}

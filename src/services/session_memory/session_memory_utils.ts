/**
 * Session Memory state, threshold checks (`10k` init, `+5k` incremental, `3`
 * tool calls), extraction wait/lock guards, and disk path resolution
 * (`~/.copilot/projects/<project>/<sessionId>/session-memory/summary.md`).
 */

import { readFile } from 'fs/promises'
import { join, sep } from 'path'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utilities/cwd.js'
import { getClaudeConfigHomeDir } from '../../utilities/env_utils.js'
import { sanitizePath } from '../../utilities/path.js'

export const EXTRACTION_WAIT_TIMEOUT_MS = 15_000
export const EXTRACTION_STALE_THRESHOLD_MS = 60_000

export interface SessionMemoryConfig {
  minimumMessageTokensToInit: number
  minimumTokensBetweenUpdate: number
  toolCallsBetweenUpdates: number
}

export const DEFAULT_SESSION_MEMORY_CONFIG: SessionMemoryConfig = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
}

let sessionMemoryConfig: SessionMemoryConfig = {
  ...DEFAULT_SESSION_MEMORY_CONFIG,
}
let sessionMemoryInitialized = false
let tokensAtLastExtraction = 0
let lastSummarizedMessageId: string | undefined
let extractionStartedAt: number | undefined

/**
 * Returns the active session's `session-memory/` directory path (trailing separator).
 */
export function getSessionMemoryDir(
  sessionId: string = getSessionId(),
  cwd: string = getOriginalCwd() || getCwd(),
): string {
  const projectKey = sanitizePath(cwd || 'default')
  return join(
    getClaudeConfigHomeDir(),
    'projects',
    projectKey,
    sessionId,
    'session-memory',
  ) + sep
}

/**
 * Returns the active session's `summary.md` file path.
 */
export function getSessionMemoryPath(
  sessionId: string = getSessionId(),
  cwd: string = getOriginalCwd() || getCwd(),
): string {
  return join(getSessionMemoryDir(sessionId, cwd), 'summary.md')
}

export function getLastSummarizedMessageId(): string | undefined {
  return lastSummarizedMessageId
}

export function setLastSummarizedMessageId(id: string | undefined): void {
  lastSummarizedMessageId = id
}

export function markExtractionStarted(): void {
  extractionStartedAt = Date.now()
}

export function markExtractionCompleted(): void {
  extractionStartedAt = undefined
}

export function isExtractionInProgress(): boolean {
  return extractionStartedAt !== undefined
}

/**
 * Waits for an in-flight session memory extraction to finish (up to 15s),
 * returning immediately if the extraction lock is older than 60s (stale).
 */
export async function waitForSessionMemoryExtraction(
  timeoutMs: number = EXTRACTION_WAIT_TIMEOUT_MS,
): Promise<void> {
  if (extractionStartedAt === undefined) {
    return
  }
  const waitStart = Date.now()
  while (extractionStartedAt !== undefined) {
    const extractionAge = Date.now() - extractionStartedAt
    if (extractionAge > EXTRACTION_STALE_THRESHOLD_MS) {
      return
    }
    if (Date.now() - waitStart >= timeoutMs) {
      return
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.min(1_000, timeoutMs))
      timer.unref?.()
    })
  }
}

/**
 * Reads the current session's `summary.md`, or returns `null` if unavailable.
 */
export async function getSessionMemoryContent(
  sessionId?: string,
  cwd?: string,
): Promise<string | null> {
  try {
    return await readFile(getSessionMemoryPath(sessionId, cwd), 'utf8')
  } catch {
    return null
  }
}

export function setSessionMemoryConfig(
  partial: Partial<SessionMemoryConfig>,
): void {
  sessionMemoryConfig = {
    minimumMessageTokensToInit:
      typeof partial.minimumMessageTokensToInit === 'number' &&
      partial.minimumMessageTokensToInit > 0
        ? partial.minimumMessageTokensToInit
        : sessionMemoryConfig.minimumMessageTokensToInit,
    minimumTokensBetweenUpdate:
      typeof partial.minimumTokensBetweenUpdate === 'number' &&
      partial.minimumTokensBetweenUpdate > 0
        ? partial.minimumTokensBetweenUpdate
        : sessionMemoryConfig.minimumTokensBetweenUpdate,
    toolCallsBetweenUpdates:
      typeof partial.toolCallsBetweenUpdates === 'number' &&
      partial.toolCallsBetweenUpdates > 0
        ? partial.toolCallsBetweenUpdates
        : sessionMemoryConfig.toolCallsBetweenUpdates,
  }
}

export function getSessionMemoryConfig(): SessionMemoryConfig {
  return { ...sessionMemoryConfig }
}

export function recordExtractionTokenCount(currentTokenCount: number): void {
  tokensAtLastExtraction = currentTokenCount
}

export function getTokensAtLastExtraction(): number {
  return tokensAtLastExtraction
}

export function isSessionMemoryInitialized(): boolean {
  return sessionMemoryInitialized
}

export function markSessionMemoryInitialized(): void {
  sessionMemoryInitialized = true
}

export function hasMetInitializationThreshold(
  currentTokenCount: number,
): boolean {
  return currentTokenCount >= sessionMemoryConfig.minimumMessageTokensToInit
}

export function hasMetUpdateThreshold(currentTokenCount: number): boolean {
  return (
    currentTokenCount - tokensAtLastExtraction >=
    sessionMemoryConfig.minimumTokensBetweenUpdate
  )
}

export function getToolCallsBetweenUpdates(): number {
  return sessionMemoryConfig.toolCallsBetweenUpdates
}

/**
 * Resets all in-memory session memory thresholds and cursors (for `/clear` and tests).
 */
export function resetSessionMemoryState(): void {
  sessionMemoryConfig = { ...DEFAULT_SESSION_MEMORY_CONFIG }
  sessionMemoryInitialized = false
  tokensAtLastExtraction = 0
  lastSummarizedMessageId = undefined
  extractionStartedAt = undefined
}

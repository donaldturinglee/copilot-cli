/**
 * Core `autoDream` background memory consolidation runner:
 * Evaluates gates cheapest-first (`enabled` -> `24h time gate` -> `10m scan
 * throttle` -> `5 touched sessions` -> `PID lock`), runs the 4-phase
 * consolidation forked agent confined to `memdir` (`createAutoMemCanUseTool`),
 * and rolls back the PID lock on error or abort.
 */

import {
  getIsRemoteMode,
  getKairosActive,
  getOriginalCwd,
  getSessionId,
} from '../../bootstrap/state.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import type { QueryDeps } from '../../query/deps.js'
import type { Message } from '../../types/message.js'
import { createChildAbortController } from '../../utilities/abort_controller.js'
import { createCacheSafeParams } from '../../utilities/cache_safe_params.js'
import { runForkedAgent } from '../../utilities/forked_agent.js'
import { createUserMessage } from '../../utilities/messages.js'
import { getProjectDir } from '../../utilities/session_storage.js'
import { logEvent } from '../analytics/index.js'
import {
  type AppendSystemMessageFn,
  createAutoMemCanUseTool,
  createMemorySavedMessage,
  type ExtractMemoriesContext,
} from '../extract_memories/extract_memories.js'
import { getAutoDreamThresholds, isAutoDreamEnabled } from './config.js'
import {
  listSessionsTouchedSince,
  readLastConsolidatedAt,
  rollbackConsolidationLock,
  tryAcquireConsolidationLock,
} from './consolidation_lock.js'
import { buildConsolidationPrompt } from './consolidation_prompt.js'

export const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000
export const AUTO_DREAM_MAX_TURNS = 30

let lastSessionScanAt = 0

export function initAutoDream(): void {
  // Ready for Stop-hook invocations
}

export function resetAutoDreamStateForTesting(): void {
  lastSessionScanAt = 0
}

function isGateOpen(): boolean {
  return (
    !getKairosActive() &&
    !getIsRemoteMode() &&
    isAutoMemoryEnabled() &&
    isAutoDreamEnabled()
  )
}

function collectTouchedFiles(messages: readonly Message[]): string[] {
  const files = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (
        block.type === 'tool_use' &&
        (block.name === 'Edit' || block.name === 'Write') &&
        block.input &&
        typeof block.input === 'object' &&
        typeof (block.input as { file_path?: unknown }).file_path === 'string'
      ) {
        files.add((block.input as { file_path: string }).file_path)
      }
    }
  }
  return Array.from(files)
}

export interface AutoDreamExecutionResult {
  ran: boolean
  reason?:
    | 'disabled'
    | 'time_gate'
    | 'scan_throttle'
    | 'session_count_gate'
    | 'lock_busy'
    | 'completed'
    | 'failed'
  filesTouched?: string[]
  sessionsReviewed?: string[]
}

/**
 * Evaluates all `autoDream` gates and runs 4-phase background consolidation
 * when eligible.
 */
export async function executeAutoDream(
  context: ExtractMemoriesContext,
  appendSystemMessage?: AppendSystemMessageFn,
  options?: {
    deps?: QueryDeps
    memoryDir?: string
    transcriptDir?: string
    nowMs?: number
    bypassGates?: boolean
  },
): Promise<AutoDreamExecutionResult> {
  if (context.toolUseContext.agentId) {
    return { ran: false, reason: 'disabled' }
  }

  const memoryRoot = options?.memoryDir ?? getAutoMemPath()
  const transcriptDir =
    options?.transcriptDir ?? getProjectDir(getOriginalCwd())
  const nowMs = options?.nowMs ?? Date.now()
  const thresholds = getAutoDreamThresholds()

  let sessionsToReview: string[] = []

  if (!options?.bypassGates) {
    // Gate 1: Feature & config enablement
    if (!isGateOpen()) {
      return { ran: false, reason: 'disabled' }
    }

    // Gate 2: Time gate (>= 24 hours since last consolidation)
    const lastConsolidatedAt = await readLastConsolidatedAt(memoryRoot)
    const hoursSince = (nowMs - lastConsolidatedAt) / 3_600_000
    if (lastConsolidatedAt > 0 && hoursSince < thresholds.minHours) {
      return { ran: false, reason: 'time_gate' }
    }

    // Gate 3: 10-minute transcript scan throttle
    if (
      lastSessionScanAt > 0 &&
      nowMs - lastSessionScanAt < SESSION_SCAN_INTERVAL_MS
    ) {
      return { ran: false, reason: 'scan_throttle' }
    }
    lastSessionScanAt = nowMs

    // Gate 4: Session count gate (>= 5 sessions excluding current session)
    const currentSid = getSessionId()
    const touched = await listSessionsTouchedSince(
      lastConsolidatedAt,
      transcriptDir,
    )
    sessionsToReview = touched.filter(sid => sid !== currentSid)
    if (sessionsToReview.length < thresholds.minSessions) {
      return { ran: false, reason: 'session_count_gate' }
    }
  }

  // Gate 5: PID-based lock acquisition
  const priorMtime = await tryAcquireConsolidationLock(memoryRoot)
  if (priorMtime === null) {
    return { ran: false, reason: 'lock_busy' }
  }

  const abortController = createChildAbortController(
    context.toolUseContext.abortController,
  )

  const extraLines = [
    'Only read-only Bash commands are permitted; writes are strictly confined to the memory directory.',
    ...(sessionsToReview.length > 0
      ? [`Sessions touched since last consolidation: ${sessionsToReview.join(', ')}`]
      : []),
  ]
  const promptText = buildConsolidationPrompt(
    memoryRoot,
    transcriptDir,
    extraLines.join('\n'),
  )

  try {
    const forkRes = await runForkedAgent({
      promptMessages: [createUserMessage({ content: promptText })],
      cacheSafeParams: createCacheSafeParams({
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        userContext: context.userContext,
        systemContext: context.systemContext,
        toolUseContext: context.toolUseContext,
      }),
      canUseTool: createAutoMemCanUseTool(memoryRoot),
      querySource: 'auto_dream',
      forkLabel: 'auto_dream',
      skipTranscript: true,
      maxTurns: AUTO_DREAM_MAX_TURNS,
      overrides: { abortController },
      deps: options?.deps,
    })

    const filesTouched = collectTouchedFiles(forkRes.messages)
    logEvent('tengu_auto_dream_completed', {
      filesTouchedCount: filesTouched.length,
      sessionsReviewedCount: sessionsToReview.length,
    })

    if (filesTouched.length > 0 && appendSystemMessage) {
      appendSystemMessage(
        createMemorySavedMessage(filesTouched, { verb: 'Improved' }),
      )
    }

    return {
      ran: true,
      reason: 'completed',
      filesTouched,
      sessionsReviewed: sessionsToReview,
    }
  } catch {
    await rollbackConsolidationLock(priorMtime, memoryRoot)
    logEvent('tengu_auto_dream_failed', {})
    return { ran: true, reason: 'failed' }
  }
}

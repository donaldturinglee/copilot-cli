/**
 * Full session restoration coordinator (`processResumedConversation`,
 * `restoreSessionStateFromLog`, `--fork-session`, `--resume-session-at`,
 * worktree re-entry, and persisted todo extraction).
 */

import type { UUID } from 'crypto'
import { dirname } from 'path'
import {
  getMainLoopModelOverride,
  getOriginalCwd,
  setCwdState,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  setOriginalCwd,
  switchSession,
} from '../bootstrap/state.js'
import { clearContextCaches } from '../context.js'
import { clearSystemPromptSections } from '../constants/system_prompt_sections.js'
import type { AppState } from '../state/app_state_store.js'
import type { AttributionState, TodoItem } from '../types/forward.js'
import { asSessionId } from '../types/ids.js'
import type { LogOption, PersistedWorktreeSession } from '../types/logs.js'
import type { Message } from '../types/message.js'
import { clearMemoryFileCaches } from './claudemd.js'
import { restoreAttributionStateFromSnapshots } from './commit_attribution.js'
import { fileHistoryRestoreStateFromLog } from './file_history.js'
import { clearAllPlanSlugs } from './plans.js'
import {
  adoptResumedSessionFile,
  recordContentReplacement,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveMode,
  saveWorktreeState,
} from './session_storage.js'

export interface ProcessResumedConversationOptions {
  forkSession?: boolean
  resumeSessionAt?: string
  explicitAgent?: string
  freshWorktree?: PersistedWorktreeSession
}

export interface ProcessResumedConversationResult {
  messages: Message[]
  sessionId: string
  restoredAttribution: AttributionState
  restoredWorktree: PersistedWorktreeSession | null
  standaloneAgentContext?: {
    name: string
    color?: string
  }
  warningMessage?: string
}

/**
 * Scans `messages` backward for the most recent `TodoWrite` `tool_use` call
 * to restore session todos on resume.
 */
export function extractTodosFromTranscript(
  messages: readonly Message[],
): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'assistant') continue
    for (let j = msg.message.content.length - 1; j >= 0; j--) {
      const block = msg.message.content[j]!
      if (
        block.type === 'tool_use' &&
        block.name === 'TodoWrite' &&
        block.input &&
        typeof block.input === 'object' &&
        'todos' in block.input &&
        Array.isArray((block.input as { todos?: unknown }).todos)
      ) {
        const rawTodos = (block.input as { todos: unknown[] }).todos
        const valid: TodoItem[] = []
        for (const item of rawTodos) {
          if (
            item &&
            typeof item === 'object' &&
            typeof (item as { content?: unknown }).content === 'string' &&
            ((item as { status?: unknown }).status === 'pending' ||
              (item as { status?: unknown }).status === 'in_progress' ||
              (item as { status?: unknown }).status === 'completed')
          ) {
            const rec = item as {
              id?: unknown
              content: string
              status: 'pending' | 'in_progress' | 'completed'
              activeForm?: unknown
            }
            valid.push({
              content: rec.content,
              status: rec.status,
              ...(typeof rec.id === 'string' ? { id: rec.id } : {}),
              ...(typeof rec.activeForm === 'string'
                ? { activeForm: rec.activeForm }
                : {}),
            })
          }
        }
        return valid
      }
    }
  }
  return []
}

let activeRestoredWorktree: PersistedWorktreeSession | null = null

/**
 * Attempts TOCTOU-safe re-entry into a persisted git worktree directory on
 * non-fork session resume.
 */
export function restoreWorktreeForResume(
  worktreeSession: PersistedWorktreeSession | null | undefined,
  freshWorktree?: PersistedWorktreeSession,
): PersistedWorktreeSession | null {
  if (freshWorktree) {
    activeRestoredWorktree = freshWorktree
    void saveWorktreeState(freshWorktree)
    return freshWorktree
  }
  if (!worktreeSession?.worktreePath) {
    return null
  }
  try {
    process.chdir(worktreeSession.worktreePath)
    setCwdState(worktreeSession.worktreePath)
    setOriginalCwd(worktreeSession.worktreePath)
    activeRestoredWorktree = worktreeSession
    clearMemoryFileCaches()
    clearContextCaches()
    clearSystemPromptSections()
    clearAllPlanSlugs()
    return worktreeSession
  } catch {
    void saveWorktreeState(null)
    return null
  }
}

/**
 * Exits any restored worktree when switching sessions mid-REPL via `/resume`.
 */
export function exitRestoredWorktree(): void {
  if (!activeRestoredWorktree) return
  const target = activeRestoredWorktree.originalCwd || getOriginalCwd()
  activeRestoredWorktree = null
  try {
    process.chdir(target)
    setCwdState(target)
    setOriginalCwd(target)
    clearMemoryFileCaches()
    clearContextCaches()
    clearSystemPromptSections()
  } catch {
    // Original CWD may no longer exist
  }
}

/**
 * Restores main-thread custom agent setting unless overridden via CLI `--agent`.
 */
export function restoreAgentFromSession(
  agentSetting: string | undefined,
  explicitAgent?: string,
  agentModelLookup?: (agentName: string) => string | undefined,
): void {
  if (explicitAgent) {
    setMainThreadAgentType(explicitAgent)
    return
  }
  if (!agentSetting) {
    setMainThreadAgentType(undefined)
    return
  }
  setMainThreadAgentType(agentSetting)
  if (!getMainLoopModelOverride() && agentModelLookup) {
    const model = agentModelLookup(agentSetting)
    if (model && model !== 'inherit') {
      setMainLoopModelOverride(model)
    }
  }
}

/**
 * Applies full session restoration semantics (non-fork session switching vs
 * `--fork-session` fresh session ID, `--resume-session-at` message slicing,
 * metadata restoration, worktree re-entry, and attribution recovery).
 */
export async function processResumedConversation(
  log: LogOption,
  messages: readonly Message[],
  options: ProcessResumedConversationOptions = {},
): Promise<ProcessResumedConversationResult> {
  let finalMessages = [...messages]

  if (options.resumeSessionAt) {
    const idx = finalMessages.findIndex(m => m.uuid === options.resumeSessionAt)
    if (idx === -1) {
      throw new Error(
        `Message UUID "${options.resumeSessionAt}" not found in resumed session.`,
      )
    }
    finalMessages = finalMessages.slice(0, idx + 1)
  }

  let effectiveSessionId = log.sessionId ?? ''
  let restoredWorktree: PersistedWorktreeSession | null = null

  if (!options.forkSession && log.sessionId) {
    const projectDir = log.fullPath ? dirname(log.fullPath) : null
    switchSession(asSessionId(log.sessionId), projectDir)
    resetSessionFilePointer()
    restoreSessionMetadata({
      customTitle: log.customTitle,
      tag: log.tag,
      agentName: log.agentName,
      agentColor: log.agentColor,
      agentSetting: log.agentSetting,
      mode: log.mode,
      worktreeSession: log.worktreeSession,
      prNumber: log.prNumber,
      prUrl: log.prUrl,
      prRepository: log.prRepository,
    })
    restoredWorktree = restoreWorktreeForResume(
      log.worktreeSession,
      options.freshWorktree,
    )
    adoptResumedSessionFile()
  } else {
    // `--fork-session`: preserve fresh startup sessionId & strip original worktree
    const { getSessionId } = await import('../bootstrap/state.js')
    effectiveSessionId = getSessionId()
    restoreSessionMetadata({
      customTitle: log.customTitle,
      tag: log.tag,
      agentName: log.agentName,
      agentColor: log.agentColor,
      agentSetting: log.agentSetting,
      mode: log.mode,
    })
    if (log.contentReplacements && log.contentReplacements.length > 0) {
      await recordContentReplacement(log.contentReplacements)
    }
  }

  restoreAgentFromSession(log.agentSetting, options.explicitAgent)

  if (log.mode) {
    await saveMode(log.mode, effectiveSessionId as UUID)
  }

  const restoredAttribution = restoreAttributionStateFromSnapshots(
    log.attributionSnapshots ?? [],
  )

  const standaloneAgentContext = log.agentName
    ? {
        name: log.agentName,
        ...(log.agentColor && log.agentColor !== 'default'
          ? { color: log.agentColor }
          : {}),
      }
    : undefined

  return {
    messages: finalMessages,
    sessionId: effectiveSessionId,
    restoredAttribution,
    restoredWorktree,
    standaloneAgentContext,
  }
}

/**
 * Hydrates `AppState` slices (`fileHistory`, `attribution`, `todos`) from a
 * resumed `LogOption`.
 */
export function restoreSessionStateFromLog(
  log: LogOption,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  todoKey = 'default',
): void {
  if (log.fileHistorySnapshots && log.fileHistorySnapshots.length > 0) {
    fileHistoryRestoreStateFromLog(log.fileHistorySnapshots, nextFh => {
      setAppState(prev => ({
        ...prev,
        fileHistory: nextFh,
      }))
    })
  }

  const attribution = restoreAttributionStateFromSnapshots(
    log.attributionSnapshots ?? [],
  )
  const todos = extractTodosFromTranscript(log.messages)

  setAppState(prev => ({
    ...prev,
    attribution,
    ...(todos.length > 0
      ? {
          todos: {
            ...prev.todos,
            [todoKey]: todos,
          },
        }
      : {}),
  }))
}

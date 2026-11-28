/**
 * Conversation recovery & deserialization pipeline for `--resume` / `--continue`:
 * - Migrates legacy attachment types (`new_file` -> `file`, `new_directory` -> `directory`)
 * - Sanitizes invalid permission modes on resumed user messages
 * - Filters unresolved `tool_use` blocks, orphaned thinking-only assistants, and
 *   whitespace-only assistants
 * - Detects interrupted turns / interrupted prompts and inserts API-validity
 *   continuation / `NO_RESPONSE_REQUESTED` sentinel blocks cleanly
 * - Restores invoked skills and replays `SessionStart('resume')` hooks
 */

import type { UUID } from 'crypto'
import { relative } from 'path'
import { addInvokedSkill, getSessionId } from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import type { LogOption, SerializedMessage } from '../types/logs.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../types/message.js'
import { PERMISSION_MODES, type PermissionMode } from '../types/permissions.js'
import { getCwd } from './cwd.js'
import { copyFileHistoryForResume } from './file_history.js'
import { executeSessionStartHooks } from './hooks.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterUnresolvedToolUses,
  NO_RESPONSE_REQUESTED,
} from './messages.js'
import { copyPlanForResume } from './plans.js'
import {
  checkResumeConsistency,
  getLastSessionLog,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
  loadMessagesFromJsonlPath,
} from './session_storage.js'

const TERMINAL_TOOL_NAMES = new Set([
  'Brief',
  'SendUserMessage',
  'SendUserFile',
])

export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_turn' }
  | { kind: 'interrupted_prompt'; message: UserMessage }

export interface DeserializedConversationResult {
  messages: Message[]
  interruption: TurnInterruptionState
}

export interface LoadedConversationForResume {
  log: LogOption
  messages: Message[]
  interruption: TurnInterruptionState
}

function isToolUseResultMessage(msg: Message): boolean {
  if (msg.type !== 'user' || !Array.isArray(msg.message.content)) {
    return false
  }
  return msg.message.content.some(b => b.type === 'tool_result')
}

function isThinkingOnlyAssistantMsg(msg: AssistantMessage): boolean {
  return (
    msg.message.content.length > 0 &&
    msg.message.content.every(
      b => b.type === 'thinking' || b.type === 'redacted_thinking',
    )
  )
}

function isWhitespaceOnlyAssistantMsg(msg: AssistantMessage): boolean {
  return (
    msg.message.content.length > 0 &&
    msg.message.content.every(
      b => b.type === 'text' && b.text.trim().length === 0,
    )
  )
}

/**
 * Migrates legacy attachment types (`new_file` -> `file`, `new_directory` ->
 * `directory`) and backfills `displayPath` relative to current CWD.
 */
export function migrateLegacyAttachmentTypes(
  messages: readonly Message[],
): Message[] {
  const cwd = getCwd()
  return messages.map(msg => {
    if (msg.type !== 'attachment') return msg
    const att = msg.attachment as Record<string, unknown>
    let type = att.type
    let changed = false

    if (type === 'new_file') {
      type = 'file'
      changed = true
    } else if (type === 'new_directory') {
      type = 'directory'
      changed = true
    }

    let displayPath = att.displayPath
    if (displayPath === undefined) {
      const candidate =
        typeof att.filename === 'string'
          ? att.filename
          : typeof att.path === 'string'
            ? att.path
            : typeof att.skillDir === 'string'
              ? att.skillDir
              : undefined
      if (candidate) {
        displayPath = relative(cwd, candidate)
        changed = true
      }
    }

    if (!changed) return msg
    return {
      ...msg,
      attachment: {
        ...att,
        type: String(type),
        ...(displayPath !== undefined ? { displayPath } : {}),
      },
    }
  })
}

/**
 * Drops orphaned thinking-only assistant messages unless another assistant
 * sharing `message.id` contains non-thinking content.
 */
export function filterOrphanedThinkingOnlyMessages(
  messages: readonly Message[],
): Message[] {
  const nonThinkingIds = new Set<string>()
  for (const msg of messages) {
    if (msg.type === 'assistant' && !isThinkingOnlyAssistantMsg(msg)) {
      if (msg.message.id) {
        nonThinkingIds.add(msg.message.id)
      }
    }
  }

  let dropped = 0
  const filtered = messages.filter(msg => {
    if (msg.type === 'assistant' && isThinkingOnlyAssistantMsg(msg)) {
      if (msg.message.id && nonThinkingIds.has(msg.message.id)) {
        return true
      }
      dropped++
      return false
    }
    return true
  })

  if (dropped > 0) {
    logEvent('tengu_filtered_orphaned_thinking_message', { count: dropped })
  }
  return filtered
}

/**
 * Drops assistant messages containing only whitespace text blocks and merges
 * newly adjacent user messages.
 */
export function filterWhitespaceOnlyAssistantMessages(
  messages: readonly Message[],
): Message[] {
  const result: Message[] = []
  let dropped = 0

  for (const msg of messages) {
    if (msg.type === 'assistant' && isWhitespaceOnlyAssistantMsg(msg)) {
      dropped++
      continue
    }
    const prev = result.at(-1)
    if (msg.type === 'user' && prev?.type === 'user') {
      const prevBlocks =
        typeof prev.message.content === 'string'
          ? [{ type: 'text' as const, text: prev.message.content }]
          : prev.message.content
      const nextBlocks =
        typeof msg.message.content === 'string'
          ? [{ type: 'text' as const, text: msg.message.content }]
          : msg.message.content
      result[result.length - 1] = {
        ...prev,
        message: {
          role: 'user',
          content: [...prevBlocks, ...nextBlocks],
        },
      }
    } else {
      result.push(msg)
    }
  }

  if (dropped > 0) {
    logEvent('tengu_filtered_whitespace_only_assistant', { count: dropped })
  }
  return result
}

function isTerminalToolResult(
  messages: readonly Message[],
  toolResultIndex: number,
): boolean {
  const trMsg = messages[toolResultIndex]
  if (!trMsg || trMsg.type !== 'user' || !Array.isArray(trMsg.message.content)) {
    return false
  }
  const resultIds = new Set<string>()
  for (const block of trMsg.message.content) {
    if (block.type === 'tool_result') {
      resultIds.add(block.tool_use_id)
    }
  }
  if (resultIds.size === 0) return false

  for (let i = toolResultIndex - 1; i >= 0; i--) {
    const prev = messages[i]!
    if (prev.type !== 'assistant') continue
    for (const block of prev.message.content) {
      if (block.type === 'tool_use' && resultIds.has(block.id)) {
        if (TERMINAL_TOOL_NAMES.has(block.name)) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Classifies whether the tail of a resumed message array ended cleanly or was
 * interrupted mid-turn / awaiting response.
 */
export function detectTurnInterruption(
  messages: readonly Message[],
): TurnInterruptionState {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'system' || msg.type === 'progress') continue
    if (msg.type === 'assistant' && msg.isApiErrorMessage) continue

    if (msg.type === 'assistant') {
      return { kind: 'none' }
    }
    if (msg.type === 'attachment') {
      return { kind: 'interrupted_turn' }
    }
    if (msg.type === 'user') {
      if (msg.isMeta || msg.isCompactSummary) {
        return { kind: 'none' }
      }
      if (isToolUseResultMessage(msg)) {
        return isTerminalToolResult(messages, i)
          ? { kind: 'none' }
          : { kind: 'interrupted_turn' }
      }
      return { kind: 'interrupted_prompt', message: msg }
    }
  }
  return { kind: 'none' }
}

/**
 * Removes an interrupted user prompt + its immediately following
 * `NO_RESPONSE_REQUESTED` sentinel pair from `messages`.
 */
export function removeInterruptedMessage(
  messages: readonly Message[],
  targetUuid: UUID,
): Message[] {
  const idx = messages.findIndex(m => m.uuid === targetUuid)
  if (idx === -1) return [...messages]
  const next = [...messages]
  const after = next[idx + 1]
  const removeCount =
    after?.type === 'assistant' &&
    after.message.content.some(
      b => b.type === 'text' && b.text === NO_RESPONSE_REQUESTED,
    )
      ? 2
      : 1
  next.splice(idx, removeCount)
  return next
}

/**
 * Replays persisted `invoked_skills` attachments from resumed messages into
 * process state so invoked skills survive subsequent compactions.
 */
export function restoreSkillStateFromMessages(
  messages: readonly Message[],
): { restoredSkillCount: number; hasSkillListing: boolean } {
  let restoredSkillCount = 0
  let hasSkillListing = false

  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    const att = msg.attachment as Record<string, unknown>
    if (att.type === 'skill_listing') {
      hasSkillListing = true
    } else if (att.type === 'invoked_skills' && Array.isArray(att.skills)) {
      for (const raw of att.skills) {
        if (
          raw &&
          typeof raw === 'object' &&
          typeof (raw as { name?: unknown }).name === 'string' &&
          typeof (raw as { content?: unknown }).content === 'string'
        ) {
          const item = raw as {
            name: string
            path?: string
            content: string
          }
          addInvokedSkill(item.name, item.path ?? '', item.content, null)
          restoredSkillCount++
        }
      }
    }
  }

  return { restoredSkillCount, hasSkillListing }
}

/**
 * Full deserialization and interruption recovery pipeline for resumed messages.
 */
export function deserializeMessagesWithInterruptDetection(
  serializedMessages: readonly (SerializedMessage | Message)[],
): DeserializedConversationResult {
  const validModes = new Set<string>(PERMISSION_MODES)

  // 1. Migrate legacy attachment types & sanitize permissionMode
  let msgs: Message[] = migrateLegacyAttachmentTypes(serializedMessages).map(
    msg => {
      if (
        msg.type === 'user' &&
        msg.permissionMode !== undefined &&
        !validModes.has(msg.permissionMode)
      ) {
        return {
          ...msg,
          permissionMode: undefined as PermissionMode | undefined,
        }
      }
      return msg
    },
  )

  // 2. Drop unresolved tool_uses, orphaned thinking-only & whitespace-only assistants
  msgs = filterUnresolvedToolUses(msgs)
  msgs = filterOrphanedThinkingOnlyMessages(msgs)
  msgs = filterWhitespaceOnlyAssistantMessages(msgs)

  // 3. Detect turn interruption
  let interruption = detectTurnInterruption(msgs)
  if (interruption.kind === 'interrupted_turn') {
    const continuationMessage = createUserMessage({
      content: 'Continue from where you left off.',
      isMeta: true,
    })
    msgs = [...msgs, continuationMessage]
    interruption = {
      kind: 'interrupted_prompt',
      message: continuationMessage,
    }
  }

  // 4. Splice API-validity sentinel immediately after trailing user message
  let lastRelevantIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.type === 'system' || m.type === 'progress') continue
    lastRelevantIdx = i
    break
  }

  if (lastRelevantIdx >= 0 && msgs[lastRelevantIdx]!.type === 'user') {
    const sentinel = createAssistantMessage({
      content: NO_RESPONSE_REQUESTED,
    })
    msgs = [
      ...msgs.slice(0, lastRelevantIdx + 1),
      sentinel,
      ...msgs.slice(lastRelevantIdx + 1),
    ]
  }

  return { messages: msgs, interruption }
}

/**
 * High-level loader for `--continue`, `--resume <id|path>`, and interactive
 * `/resume` picker selection.
 */
export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile?: string,
  options?: { projectPath?: string; skipSessionStartHooks?: boolean },
): Promise<LoadedConversationForResume | null> {
  let log: LogOption | null = null

  if (sourceJsonlFile) {
    log = await loadMessagesFromJsonlPath(sourceJsonlFile)
  } else if (source === undefined) {
    const logs = await loadMessageLogs(options?.projectPath)
    log = logs[0] ?? null
  } else if (typeof source === 'string') {
    log = await getLastSessionLog(source as UUID, options?.projectPath)
  } else {
    log = isLiteLog(source) ? await loadFullLog(source) : source
  }

  if (!log) {
    return null
  }
  if (isLiteLog(log)) {
    log = await loadFullLog(log)
  }

  const currentSid = getSessionId()
  if (log.sessionId && log.sessionId !== currentSid) {
    copyPlanForResume(log.sessionId, currentSid)
  }
  void copyFileHistoryForResume(log).catch(() => {})

  checkResumeConsistency(log.messages)
  restoreSkillStateFromMessages(log.messages)

  const deserialized = deserializeMessagesWithInterruptDetection(log.messages)
  const messages = [...deserialized.messages]

  if (!options?.skipSessionStartHooks) {
    const hookRes = await executeSessionStartHooks({
      source: 'resume',
    })
    if (hookRes.additionalContexts.length > 0) {
      messages.push(
        createUserMessage({
          content: `<system-reminder>\n${hookRes.additionalContexts.join('\n')}\n</system-reminder>`,
          isMeta: true,
        }),
      )
    }
  }

  return {
    log,
    messages,
    interruption: deserialized.interruption,
  }
}

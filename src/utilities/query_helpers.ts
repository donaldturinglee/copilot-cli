/**
 * Headless/SDK message normalization, result-success validation, bash command
 * extraction, and Phase 2 `FileStateCache` shim (extended in Phase 3.2).
 */

import { getSessionId } from '../bootstrap/state.js'
import type { Message } from '../types/message.js'
import { randomUUID } from './crypto.js'
import { isEnvTruthy } from './env_utils.js'
import {
  cloneFileStateCache,
  createFileStateCache,
  type FileState,
  FileStateCache,
} from './file_state_cache.js'
import { isNotEmptyMessage, normalizeMessages } from './messages.js'
import type { SdkMessage } from './messages/mappers.js'

const TOOL_PROGRESS_THROTTLE_MS = 30_000
const MAX_TOOL_PROGRESS_TRACKING_ENTRIES = 100

const lastToolProgressEmittedAt = new Map<string, number>()

export type FileStateCacheEntry = FileState
export { cloneFileStateCache, createFileStateCache, FileStateCache }

/**
 * Determines whether the final message of a turn represents a valid completed
 * result (assistant ending in text/thinking, user tool_result carrier, or
 * explicit `stopReason === 'end_turn'`).
 */
export function isResultSuccessful(
  message: Message | undefined,
  stopReason: string | null = null,
): boolean {
  if (!message) {
    return false
  }
  if (message.type === 'assistant') {
    const lastBlock = message.message.content.at(-1)
    if (
      lastBlock &&
      (lastBlock.type === 'text' ||
        lastBlock.type === 'thinking' ||
        lastBlock.type === 'redacted_thinking')
    ) {
      return true
    }
  }
  if (message.type === 'user') {
    const content = message.message.content
    if (
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(block => 'type' in block && block.type === 'tool_result')
    ) {
      return true
    }
  }
  return stopReason === 'end_turn'
}

/**
 * Normalizes an internal `Message` into zero or more external `SdkMessage` wire events.
 */
export function* normalizeMessage(
  message: Message,
): Generator<SdkMessage, void> {
  const sessionId = getSessionId()

  if (message.type === 'assistant') {
    for (const normalized of normalizeMessages([message])) {
      if (normalized.type !== 'assistant' || !isNotEmptyMessage(normalized)) {
        continue
      }
      yield {
        type: 'assistant',
        message: normalized.message,
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: normalized.uuid,
        ...(normalized.error ? { error: normalized.error } : {}),
      }
    }
    return
  }

  if (message.type === 'user') {
    for (const normalized of normalizeMessages([message])) {
      if (normalized.type !== 'user') continue
      yield {
        type: 'user',
        message: normalized.message,
        parent_tool_use_id: null,
        session_id: sessionId,
        uuid: normalized.uuid,
        timestamp: normalized.timestamp,
        ...(normalized.isMeta || normalized.isVisibleInTranscriptOnly
          ? { isSynthetic: true }
          : {}),
        ...(normalized.toolUseResult !== undefined || normalized.mcpMeta
          ? {
              tool_use_result: normalized.mcpMeta
                ? {
                    content: normalized.toolUseResult,
                    ...normalized.mcpMeta,
                  }
                : normalized.toolUseResult,
            }
          : {}),
      }
    }
    return
  }

  if (message.type === 'progress') {
    const data = message.data as Record<string, unknown>
    const dataType = typeof data.type === 'string' ? data.type : ''

    if (
      (dataType === 'agent_progress' || dataType === 'skill_progress') &&
      data.message
    ) {
      for (const normalized of normalizeMessages([data.message as Message])) {
        if (normalized.type === 'assistant') {
          yield {
            type: 'assistant',
            message: normalized.message,
            parent_tool_use_id: message.parentToolUseId,
            session_id: sessionId,
            uuid: normalized.uuid,
            ...(normalized.error ? { error: normalized.error } : {}),
          }
        } else if (normalized.type === 'user') {
          yield {
            type: 'user',
            message: normalized.message,
            parent_tool_use_id: message.parentToolUseId,
            session_id: sessionId,
            uuid: normalized.uuid,
            timestamp: normalized.timestamp,
          }
        }
      }
      return
    }

    if (
      (dataType === 'bash_progress' || dataType === 'powershell_progress') &&
      (isEnvTruthy(process.env.COPILOT_CLI_REMOTE) ||
        Boolean(process.env.COPILOT_CLI_CONTAINER_ID))
    ) {
      const now = Date.now()
      const lastAt = lastToolProgressEmittedAt.get(message.parentToolUseId) ?? 0
      if (now - lastAt < TOOL_PROGRESS_THROTTLE_MS) {
        return
      }
      if (lastToolProgressEmittedAt.size >= MAX_TOOL_PROGRESS_TRACKING_ENTRIES) {
        const oldestKey = lastToolProgressEmittedAt.keys().next().value
        if (oldestKey !== undefined) {
          lastToolProgressEmittedAt.delete(oldestKey)
        }
      }
      lastToolProgressEmittedAt.set(message.parentToolUseId, now)

      yield {
        type: 'tool_progress',
        tool_use_id: message.toolUseId,
        tool_name: dataType === 'powershell_progress' ? 'PowerShell' : 'Bash',
        parent_tool_use_id: message.parentToolUseId,
        elapsed_time_seconds:
          typeof data.elapsedTimeSeconds === 'number'
            ? data.elapsedTimeSeconds
            : 0,
        ...(typeof data.taskId === 'string' ? { task_id: data.taskId } : {}),
        session_id: sessionId,
        uuid: randomUUID(),
      }
    }
  }
}

/**
 * Extracts base command executables from Bash tool calls in message history,
 * skipping leading `VAR=val` assignments and `sudo`.
 */
export function extractBashToolsFromMessages(
  messages: readonly Message[],
): Set<string> {
  const commands = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    for (const block of msg.message.content) {
      if (block.type !== 'tool_use' || block.name !== 'Bash') continue
      const input = block.input as { command?: unknown } | undefined
      if (typeof input?.command !== 'string') continue
      const subcommands = input.command.split(/(?:&&|\|\||[;|])/)
      for (const sub of subcommands) {
        const tokens = sub.trim().split(/\s+/).filter(Boolean)
        let idx = 0
        while (idx < tokens.length) {
          const tok = tokens[idx]!
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) || tok === 'sudo') {
            idx++
            continue
          }
          const slashIdx = tok.lastIndexOf('/')
          commands.add(slashIdx >= 0 ? tok.slice(slashIdx + 1) : tok)
          break
        }
      }
    }
  }
  return commands
}

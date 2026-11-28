/**
 * Interactive checkpoint rewind dialog (`MessageSelector`) triggered by
 * `/rewind` or double-`Esc`, supporting `both`, `conversation`, `code`,
 * `summarize` (partial compact `'from'`), `summarize_up_to`, and `nevermind`
 * modes with dry-run disk diff previews.
 */

import type { UUID } from 'crypto'
import { basename } from 'path'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box } from '../ink/components/box.js'
import type { InputEvent } from '../ink/events/input_event.js'
import type { Key } from '../ink/events/keyboard_event.js'
import { useInput } from '../ink/hooks/use_input.js'
import { useAppState } from '../state/app_state.js'
import type {
  Message,
  PartialCompactDirection,
  UserMessage,
} from '../types/message.js'
import { randomUUID } from '../utilities/crypto.js'
import { countLinesChanged, type StructuredPatchHunk } from '../utilities/diff.js'
import { parseDisplayTags } from '../utilities/display_tags.js'
import {
  type DiffStats,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
} from '../utilities/file_history.js'
import {
  extractTextContent,
  isSyntheticMessage,
} from '../utilities/messages.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'
import { Spinner } from './spinner.js'

export const MAX_VISIBLE_MESSAGES = 7

export type RestoreOption =
  | 'both'
  | 'conversation'
  | 'code'
  | 'summarize'
  | 'summarize_up_to'
  | 'nevermind'

const EXCLUDED_USER_TAGS = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
  '<tick>',
  '<teammate-message',
]

/**
 * Filter matching user prompts eligible as rewind / checkpoint targets.
 */
export function selectableUserMessagesFilter(
  message: Message,
): message is UserMessage {
  if (message.type !== 'user') return false
  if (message.isMeta || message.isCompactSummary || message.isVisibleInTranscriptOnly) {
    return false
  }
  if (isSyntheticMessage(message)) return false
  const content = message.message.content
  if (Array.isArray(content) && content[0]?.type === 'tool_result') {
    return false
  }
  const text = extractTextContent(content)
  if (!text.trim()) return false
  return !EXCLUDED_USER_TAGS.some(tag => text.includes(tag))
}

/**
 * Returns `true` if every message after `fromIndex` is synthetic, system,
 * progress, or meta (allowing lossless auto-undo on single-Esc cancel).
 */
export function messagesAfterAreOnlySynthetic(
  messages: readonly Message[],
  fromIndex: number,
): boolean {
  for (let i = fromIndex + 1; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'system' || msg.type === 'progress') continue
    if (msg.type === 'assistant' && msg.isApiErrorMessage) continue
    if (isSyntheticMessage(msg)) continue
    if (msg.type === 'user' && msg.isMeta) continue
    return false
  }
  return true
}

/**
 * Extracts editable prompt text and input mode (`'prompt'` vs `'bash'`) when
 * restoring a user message back into the input box.
 */
export function textForResubmit(message: UserMessage): {
  text: string
  mode: 'prompt' | 'bash'
} {
  const raw = extractTextContent(message.message.content)
  const bashMatch = raw.match(/<bash-input>([\s\S]*?)<\/bash-input>/)
  if (bashMatch?.[1]) {
    return { text: bashMatch[1].trim(), mode: 'bash' }
  }
  const cmdNameMatch = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)
  if (cmdNameMatch?.[1]) {
    const argsMatch = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)
    const cmd = cmdNameMatch[1].trim()
    const args = argsMatch?.[1]?.trim() ?? ''
    return {
      text: args ? `${cmd} ${args}` : cmd,
      mode: 'prompt',
    }
  }
  return { text: parseDisplayTags(raw).plainText.trim(), mode: 'prompt' }
}

/**
 * Computes per-turn file diff statistics between `fromUuid` and `nextUuid` by
 * scanning Edit/Write `toolUseResult` entries inside that turn span.
 */
export function computeDiffStatsBetweenMessages(
  messages: readonly Message[],
  fromUuid: UUID,
  nextUuid?: UUID,
): { filesChanged: string[]; insertions: number; deletions: number } {
  const startIdx = messages.findIndex(m => m.uuid === fromUuid)
  if (startIdx === -1) {
    return { filesChanged: [], insertions: 0, deletions: 0 }
  }
  const endIdx = nextUuid
    ? messages.findIndex((m, idx) => idx > startIdx && m.uuid === nextUuid)
    : messages.length
  const stopAt = endIdx === -1 ? messages.length : endIdx

  const filesSet = new Set<string>()
  let insertions = 0
  let deletions = 0

  for (let i = startIdx + 1; i < stopAt; i++) {
    const msg = messages[i]!
    if (msg.type !== 'user' || !msg.toolUseResult) continue
    const res = msg.toolUseResult as {
      filePath?: unknown
      structuredPatch?: unknown
      type?: unknown
    }
    if (typeof res.filePath === 'string') {
      filesSet.add(res.filePath)
    }
    if (Array.isArray(res.structuredPatch)) {
      const counts = countLinesChanged(
        res.structuredPatch as StructuredPatchHunk[],
      )
      insertions += counts.added
      deletions += counts.removed
    }
  }

  return {
    filesChanged: Array.from(filesSet),
    insertions,
    deletions,
  }
}

function formatMessagePreview(message: UserMessage, maxChars = 64): string {
  const { text, mode } = textForResubmit(message)
  const display = mode === 'bash' ? `! ${text}` : text
  const singleLine = display.replace(/\s+/g, ' ').trim() || '((empty message))'
  return singleLine.length > maxChars
    ? `${singleLine.slice(0, maxChars - 1)}\u2026`
    : singleLine
}

function formatCodeRestoreSummary(stats: DiffStats): string {
  if (!stats?.filesChanged || stats.filesChanged.length === 0) {
    return 'The code has not changed (nothing will be restored).'
  }
  const count = stats.filesChanged.length
  const first = basename(stats.filesChanged[0]!)
  const filesLabel =
    count === 1
      ? first
      : count === 2
        ? `${first} and ${basename(stats.filesChanged[1]!)}`
        : `${first} and ${count - 1} other files`
  return `The code will be restored +${stats.insertions} -${stats.deletions} in ${filesLabel}.`
}

export interface MessageSelectorProps {
  messages: readonly Message[]
  onPreRestore: () => void
  onRestoreMessage: (message: UserMessage) => Promise<void>
  onRestoreCode: (message: UserMessage) => Promise<void>
  onSummarize: (
    message: UserMessage,
    feedback?: string,
    direction?: PartialCompactDirection,
  ) => Promise<void>
  onClose: () => void
  preselectedMessage?: UserMessage
  width?: number
}

/**
 * Interactive checkpoint / rewind picker and mode confirmation dialog.
 */
export function MessageSelector({
  messages,
  onPreRestore,
  onRestoreMessage,
  onRestoreCode,
  onSummarize,
  onClose,
  preselectedMessage,
  width = 76,
}: MessageSelectorProps): React.ReactNode {
  const fileHistory = useAppState(s => s.fileHistory)
  const isFileHistoryOn = fileHistoryEnabled()
  const currentUuid = useMemo(() => randomUUID(), [])

  const selectableMessages = useMemo(
    () => messages.filter(selectableUserMessagesFilter),
    [messages],
  )

  const optionItems = useMemo(() => {
    const currentSentinel: UserMessage = {
      type: 'user',
      uuid: currentUuid,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: '(current)' },
    }
    return [...selectableMessages, currentSentinel]
  }, [selectableMessages, currentUuid])

  const [selectedIndex, setSelectedIndex] = useState<number>(
    Math.max(0, optionItems.length - 1),
  )
  const [messageToRestore, setMessageToRestore] = useState<UserMessage | null>(
    preselectedMessage ?? null,
  )
  const [diffStatsForRestore, setDiffStatsForRestore] =
    useState<DiffStats>(undefined)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isSummarizing, setIsSummarizing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [summarizeFeedback, setSummarizeFeedback] = useState('')
  const [editingFeedbackMode, setEditingFeedbackMode] = useState<
    null | 'from' | 'up_to'
  >(null)

  // Compute dry-run cumulative disk diff stats whenever a target is picked
  useEffect(() => {
    if (!messageToRestore || !isFileHistoryOn) {
      setDiffStatsForRestore(undefined)
      return
    }
    let cancelled = false
    void fileHistoryGetDiffStats(fileHistory, messageToRestore.uuid).then(
      stats => {
        if (!cancelled) {
          setDiffStatsForRestore(stats)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [messageToRestore, fileHistory, isFileHistoryOn])

  const canRestoreCode =
    isFileHistoryOn &&
    Boolean(diffStatsForRestore?.filesChanged?.length)

  const handleSelectFromList = useCallback(
    async (msg: UserMessage) => {
      if (msg.uuid === currentUuid || !messages.includes(msg)) {
        onClose()
        return
      }
      if (!isFileHistoryOn) {
        setIsRestoring(true)
        try {
          onPreRestore()
          await onRestoreMessage(msg)
          onClose()
        } catch (err) {
          setErrorMessage(err instanceof Error ? err.message : String(err))
        } finally {
          setIsRestoring(false)
        }
        return
      }
      setErrorMessage(null)
      setMessageToRestore(msg)
    },
    [currentUuid, messages, onClose, isFileHistoryOn, onPreRestore, onRestoreMessage],
  )

  const executeRestoreOption = useCallback(
    async (option: RestoreOption) => {
      if (!messageToRestore) return
      if (option === 'nevermind') {
        if (preselectedMessage) onClose()
        else setMessageToRestore(null)
        return
      }

      if (option === 'summarize' || option === 'summarize_up_to') {
        const direction: PartialCompactDirection =
          option === 'summarize_up_to' ? 'up_to' : 'from'
        setIsSummarizing(true)
        setErrorMessage(null)
        try {
          onPreRestore()
          await onSummarize(
            messageToRestore,
            summarizeFeedback.trim() || undefined,
            direction,
          )
          onClose()
        } catch (err) {
          setErrorMessage(err instanceof Error ? err.message : String(err))
        } finally {
          setIsSummarizing(false)
        }
        return
      }

      setIsRestoring(true)
      setErrorMessage(null)
      onPreRestore()

      const errors: string[] = []
      if (option === 'both' || option === 'code') {
        try {
          await onRestoreCode(messageToRestore)
        } catch (err) {
          errors.push(
            `Code restore failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      if (option === 'both' || option === 'conversation') {
        try {
          await onRestoreMessage(messageToRestore)
        } catch (err) {
          errors.push(
            `Conversation restore failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      setIsRestoring(false)
      if (errors.length > 0) {
        setErrorMessage(errors.join(' | '))
      } else {
        onClose()
      }
    },
    [
      messageToRestore,
      preselectedMessage,
      onClose,
      onPreRestore,
      onSummarize,
      summarizeFeedback,
      onRestoreCode,
      onRestoreMessage,
    ],
  )

  // Pick-list keyboard navigation
  useInput(
    useCallback(
      (ch: string, key: Key, event: InputEvent) => {
        if (event.immediatePropagationStopped) return
        if (isRestoring || isSummarizing) return

        if (editingFeedbackMode !== null) {
          if (key.escape) {
            setEditingFeedbackMode(null)
            event.stopImmediatePropagation()
            return
          }
          if (key.return) {
            const dir = editingFeedbackMode
            setEditingFeedbackMode(null)
            void executeRestoreOption(
              dir === 'up_to' ? 'summarize_up_to' : 'summarize',
            )
            event.stopImmediatePropagation()
            return
          }
          if (key.backspace || key.delete) {
            setSummarizeFeedback(prev => prev.slice(0, -1))
            event.stopImmediatePropagation()
            return
          }
          if (ch && !key.ctrl && !key.meta) {
            setSummarizeFeedback(prev => prev + ch)
            event.stopImmediatePropagation()
          }
          return
        }

        if (messageToRestore !== null) {
          return
        }

        if (key.escape) {
          onClose()
          event.stopImmediatePropagation()
          return
        }
        if (key.upArrow || ch === 'k' || (key.ctrl && ch === 'p')) {
          setSelectedIndex(prev => Math.max(0, prev - 1))
          event.stopImmediatePropagation()
          return
        }
        if (key.downArrow || ch === 'j' || (key.ctrl && ch === 'n')) {
          setSelectedIndex(prev => Math.min(optionItems.length - 1, prev + 1))
          event.stopImmediatePropagation()
          return
        }
        if (ch === 'K' || (key.shift && key.upArrow)) {
          setSelectedIndex(0)
          event.stopImmediatePropagation()
          return
        }
        if (ch === 'J' || (key.shift && key.downArrow)) {
          setSelectedIndex(Math.max(0, optionItems.length - 1))
          event.stopImmediatePropagation()
          return
        }
        if (key.return) {
          const picked = optionItems[selectedIndex]
          if (picked) {
            void handleSelectFromList(picked)
          }
          event.stopImmediatePropagation()
        }
      },
      [
        isRestoring,
        isSummarizing,
        editingFeedbackMode,
        executeRestoreOption,
        messageToRestore,
        onClose,
        optionItems,
        selectedIndex,
        handleSelectFromList,
      ],
    ),
  )

  const confirmOptions = useMemo(() => {
    const items: Array<{ value: RestoreOption; label: string; description?: string }> = []
    if (canRestoreCode) {
      items.push({
        value: 'both',
        label: 'Restore code and conversation',
        description: 'Roll back modified files and conversation history',
      })
    }
    items.push({
      value: 'conversation',
      label: 'Restore conversation',
      description: 'Keep current disk files; rewind conversation only',
    })
    if (canRestoreCode) {
      items.push({
        value: 'code',
        label: 'Restore code',
        description: 'Roll back modified files; keep conversation history',
      })
    }
    items.push({
      value: 'summarize',
      label: summarizeFeedback
        ? `Summarize from here: ${summarizeFeedback}`
        : 'Summarize from here',
      description: 'Compact messages from this point onward (preserves prefix cache)',
    })
    if (process.env.USER_TYPE === 'ant') {
      items.push({
        value: 'summarize_up_to',
        label: 'Summarize up to here',
        description: 'Compact earlier messages before this point',
      })
    }
    items.push({
      value: 'nevermind',
      label: 'Never mind',
    })
    return items
  }, [canRestoreCode, summarizeFeedback])

  const firstVisibleIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_MESSAGES / 2),
      Math.max(0, optionItems.length - MAX_VISIBLE_MESSAGES),
    ),
  )
  const visibleSlice = optionItems.slice(
    firstVisibleIndex,
    firstVisibleIndex + MAX_VISIBLE_MESSAGES,
  )

  return (
    <Dialog
      title="Rewind Checkpoint (/rewind)"
      subtitle={
        messageToRestore
          ? 'Choose how to restore · Esc to go back'
          : 'Select a checkpoint · ↑/↓ navigate · Enter select · Esc cancel'
      }
      width={width}
      overlayId="message-selector"
      onCancel={
        messageToRestore
          ? () => {
              if (preselectedMessage) onClose()
              else setMessageToRestore(null)
            }
          : onClose
      }
    >
      {errorMessage ? (
        <Box marginBottom={1}>
          <ThemedText color="error">{errorMessage}</ThemedText>
        </Box>
      ) : null}

      {isSummarizing ? (
        <Spinner mode="thinking" message="Summarizing…" />
      ) : isRestoring ? (
        <Spinner mode="thinking" message="Restoring checkpoint…" />
      ) : optionItems.length <= 1 ? (
        <ThemedText dimColor>Nothing to rewind to yet.</ThemedText>
      ) : messageToRestore ? (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <ThemedText bold>
              Selected prompt: {formatMessagePreview(messageToRestore, width - 24)}
            </ThemedText>
            <ThemedText dimColor>
              {formatCodeRestoreSummary(diffStatsForRestore)}
            </ThemedText>
            <ThemedText color="warning">
              ⚠ Rewinding does not affect files edited manually or via bash.
            </ThemedText>
          </Box>

          {editingFeedbackMode ? (
            <Box flexDirection="column">
              <ThemedText>
                Optional summary context (Enter to confirm, Esc to cancel):
              </ThemedText>
              <ThemedText color="claude">&gt; {summarizeFeedback}_</ThemedText>
            </Box>
          ) : (
            <Select<RestoreOption>
              options={confirmOptions}
              defaultValue={canRestoreCode ? 'both' : 'conversation'}
              onChange={opt => void executeRestoreOption(opt)}
              onCancel={() => {
                if (preselectedMessage) onClose()
                else setMessageToRestore(null)
              }}
            />
          )}
        </Box>
      ) : (
        <Box flexDirection="column">
          {visibleSlice.map((msg, localIdx) => {
            const globalIdx = firstVisibleIndex + localIdx
            const isSelected = globalIdx === selectedIndex
            const isCurrent = msg.uuid === currentUuid
            const nextMsg =
              !isCurrent && globalIdx + 1 < selectableMessages.length
                ? selectableMessages[globalIdx + 1]
                : undefined

            let subtitle = ''
            if (!isCurrent && isFileHistoryOn) {
              const hasSnap = fileHistoryCanRestore(fileHistory, msg.uuid)
              if (!hasSnap) {
                subtitle = '⚠ No code restore'
              } else {
                const stats = computeDiffStatsBetweenMessages(
                  messages,
                  msg.uuid,
                  nextMsg?.uuid,
                )
                if (stats.filesChanged.length === 0) {
                  subtitle = 'No code changes'
                } else if (stats.filesChanged.length === 1) {
                  subtitle = `${basename(stats.filesChanged[0]!)} +${stats.insertions} -${stats.deletions}`
                } else {
                  subtitle = `${stats.filesChanged.length} files changed +${stats.insertions} -${stats.deletions}`
                }
              }
            }

            return (
              <Box key={msg.uuid} flexDirection="column" marginBottom={0}>
                <ThemedText
                  bold={isSelected}
                  color={isSelected ? 'claude' : undefined}
                >
                  {isSelected ? '❯ ' : '  '}
                  {isCurrent
                    ? '(current)'
                    : formatMessagePreview(msg, Math.max(24, width - 12))}
                </ThemedText>
                {subtitle ? (
                  <ThemedText dimColor>{`    ${subtitle}`}</ThemedText>
                ) : null}
              </Box>
            )
          })}
        </Box>
      )}
    </Dialog>
  )
}

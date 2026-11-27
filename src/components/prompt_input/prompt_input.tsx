import React, { useCallback, useState } from 'react'
import type { PromptHistoryEntry } from '../../history.js'
import { useArrowKeyHistory } from '../../hooks/use_arrow_key_history.js'
import { useInputBuffer } from '../../hooks/use_input_buffer.js'
import { usePasteHandler } from '../../hooks/use_paste_handler.js'
import { useTextInput } from '../../hooks/use_text_input.js'
import { useTypeahead } from '../../hooks/use_typeahead.js'
import { Box } from '../../ink/components/box.js'
import type { InputEvent } from '../../ink/events/input_event.js'
import type { Key } from '../../ink/events/keyboard_event.js'
import { useInput } from '../../ink/hooks/use_input.js'
import type { Command } from '../../types/command.js'
import type { PermissionMode } from '../../types/permissions.js'
import { launchExternalEditor } from '../../utilities/editor.js'
import type { QueuedPromptItem } from '../../utilities/message_queue_manager.js'
import type {
  FileSuggestionEngine,
  MentionResource,
} from '../../utilities/suggestions/file_suggestions.js'
import type { VimMode } from '../../vim/types.js'
import { BaseTextInput } from '../base_text_input.js'
import { ThemedBox } from '../design_system/themed_box.js'
import { ThemedText } from '../design_system/themed_text.js'
import { VimTextInput } from '../vim_text_input.js'

export type PromptInputProps = {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  commands: readonly Command[]
  fileEngine: FileSuggestionEngine
  historyEntries?: readonly PromptHistoryEntry[]
  queuedItems?: readonly QueuedPromptItem[]
  members?: readonly MentionResource[]
  mcpResources?: readonly MentionResource[]
  agents?: readonly MentionResource[]
  permissionMode?: PermissionMode
  vimEnabled?: boolean
  isLoading?: boolean
  isActive?: boolean
  placeholder?: string
  columns?: number
  cwd?: string
  onCyclePermissionMode?: () => void
  onOpenHistorySearch?: () => void
  onImagePasteTrigger?: () => void
}

/**
 * Interactive REPL input composer combining:
 * - Readline/Emacs & 11-state Vim editing modes
 * - 8-tier priority typeahead completion dropdown
 * - 100ms debounced paste folding (`[Pasted text #N +X lines]`)
 * - `!` bash shell mode visual chrome
 * - `$EDITOR` external buffer launch (`Ctrl+G` / `Ctrl+X Ctrl+E`)
 * - Queued prompt indicators while streaming
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  commands,
  fileEngine,
  historyEntries = [],
  queuedItems = [],
  members = [],
  mcpResources = [],
  agents = [],
  permissionMode = 'default',
  vimEnabled = false,
  isLoading = false,
  isActive = true,
  placeholder = 'Ask Copilot anything… (/help for commands, !cmd for shell)',
  columns = 80,
  cwd,
  onCyclePermissionMode,
  onOpenHistorySearch,
  onImagePasteTrigger,
}: PromptInputProps): React.ReactNode {
  const { controller, hasStash, notify } = useInputBuffer(value)
  const [vimMode, setVimMode] = useState<VimMode>('INSERT')

  if (controller.text !== value) {
    controller.setValue(value, Math.min(controller.cursor, value.length), false)
  }

  const syncValue = useCallback(
    (nextText: string, nextCursor?: number) => {
      controller.setValue(nextText, nextCursor ?? nextText.length, false)
      onChange(nextText)
      notify()
    },
    [controller, onChange, notify],
  )

  const history = useArrowKeyHistory(
    historyEntries,
    () => controller.text,
    next => syncValue(next, next.length),
  )

  const typeahead = useTypeahead({
    input: controller.text,
    cursor: controller.cursor,
    commands,
    fileEngine,
    historyEntries,
    members,
    mcpResources,
    agents,
    cwd,
  })

  const { handlePaste } = usePasteHandler({
    onInsertText: inserted => {
      controller.insert(inserted)
      onChange(controller.text)
      notify()
    },
    onEmptyPaste: onImagePasteTrigger,
  })

  const handleOpenExternalEditor = useCallback(() => {
    const res = launchExternalEditor(controller.text)
    if (res.ok) {
      syncValue(res.text, res.text.length)
    }
  }, [controller.text, syncValue])

  const handleSubmit = useCallback(
    (submitted: string) => {
      if (!submitted.trim()) return
      history.reset()
      onSubmit(submitted)
    },
    [history, onSubmit],
  )

  // Intercept autocomplete keys, Shift+Tab mode cycling, and Ctrl+R history search
  useInput(
    useCallback(
      (input: string, key: Key, event: InputEvent) => {
        if (!isActive || event.immediatePropagationStopped) return

        if (key.tab && key.shift && onCyclePermissionMode) {
          onCyclePermissionMode()
          event.stopImmediatePropagation()
          return
        }

        if (key.ctrl && input.toLowerCase() === 'r' && onOpenHistorySearch) {
          onOpenHistorySearch()
          event.stopImmediatePropagation()
          return
        }

        if (typeahead.isOpen) {
          if (key.tab) {
            const accepted = typeahead.acceptSelected()
            if (accepted) {
              syncValue(accepted.text, accepted.cursor)
            }
            event.stopImmediatePropagation()
            return
          }
          if (key.downArrow) {
            typeahead.selectNext()
            event.stopImmediatePropagation()
            return
          }
          if (key.upArrow) {
            typeahead.selectPrevious()
            event.stopImmediatePropagation()
            return
          }
          if (key.escape) {
            typeahead.dismiss()
            event.stopImmediatePropagation()
            return
          }
        }
      },
      [
        isActive,
        onCyclePermissionMode,
        onOpenHistorySearch,
        typeahead,
        syncValue,
      ],
    ),
    { isActive },
  )

  useTextInput({
    controller,
    onChange: next => {
      onChange(next)
      notify()
    },
    onSubmit: handleSubmit,
    onHistoryPrev: history.navigatePrevious,
    onHistoryNext: history.navigateNext,
    onExternalEditor: handleOpenExternalEditor,
    onImagePasteTrigger,
    multiline: true,
    isActive: isActive && !vimEnabled,
  })

  const isBashMode = controller.text.startsWith('!')

  return (
    <Box
      flexDirection="column"
      width={columns}
      onPaste={ev => {
        handlePaste(ev.text, ev.text.length === 0)
      }}
    >
      {queuedItems.length > 0 ? (
        <Box flexDirection="column" paddingX={1}>
          {queuedItems.map((q, idx) => (
            <ThemedText key={q.id} dimColor wrap="truncate-end">
              Queued ({idx + 1}): {q.text}
            </ThemedText>
          ))}
        </Box>
      ) : null}

      <ThemedBox
        borderStyle="round"
        borderColor={isBashMode ? 'bashBorder' : 'promptBorder'}
        paddingX={1}
        flexDirection="row"
        gap={1}
      >
        <ThemedText color={isBashMode ? 'bashBorder' : 'claude'} bold>
          {isBashMode ? '!' : '❯'}
        </ThemedText>
        {vimEnabled ? (
          <VimTextInput
            value={controller.text}
            placeholder={placeholder}
            initialMode={vimMode}
            isActive={isActive}
            onChange={(nextText, nextCursor, nextMode) => {
              setVimMode(nextMode)
              controller.setValue(nextText, nextCursor, false)
              onChange(nextText)
              notify()
            }}
            onSubmit={handleSubmit}
            onModeChange={setVimMode}
          />
        ) : (
          <BaseTextInput
            value={controller.text}
            cursor={controller.cursor}
            placeholder={placeholder}
            showCursor={isActive}
            multiline={true}
            viewportWidth={Math.max(20, columns - 6)}
          />
        )}
      </ThemedBox>

      {typeahead.isOpen ? (
        <ThemedBox
          flexDirection="column"
          paddingX={2}
          borderStyle="single"
          borderColor="subtle"
        >
          {typeahead.suggestions.slice(0, 8).map((item, idx) => {
            const active = idx === typeahead.selectedIndex
            return (
              <Box
                key={item.id}
                flexDirection="row"
                justifyContent="space-between"
                gap={2}
              >
                <ThemedText
                  color={active ? 'claude' : 'text'}
                  bold={active}
                >
                  {active ? '❯ ' : '  '}
                  {item.displayText}
                </ThemedText>
                {item.description ? (
                  <ThemedText dimColor wrap="truncate-end">
                    {item.description}
                  </ThemedText>
                ) : null}
              </Box>
            )
          })}
        </ThemedBox>
      ) : null}

      <Box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
      >
        <Box flexDirection="row" gap={2}>
          <ThemedText dimColor>
            mode: {permissionMode} (Shift+Tab)
          </ThemedText>
          {vimEnabled ? (
            <ThemedText color="suggestion">vim: {vimMode}</ThemedText>
          ) : null}
          {hasStash ? (
            <ThemedText color="warning">draft stashed (Ctrl+S)</ThemedText>
          ) : null}
        </Box>
        <ThemedText dimColor>
          {isLoading
            ? 'Streaming… type to queue · Esc to cancel'
            : '? /help · Ctrl+O transcript · Ctrl+R history'}
        </ThemedText>
      </Box>
    </Box>
  )
}

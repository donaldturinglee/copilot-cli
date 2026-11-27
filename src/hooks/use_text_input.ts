import { useCallback } from 'react'
import type { InputEvent } from '../ink/events/input_event.js'
import type { Key } from '../ink/events/keyboard_event.js'
import { useInput } from '../ink/hooks/use_input.js'
import type { InputBufferController } from './use_input_buffer.js'

export type UseTextInputOptions = {
  controller: InputBufferController
  onChange: (value: string, cursor: number) => void
  onSubmit?: (value: string) => void
  onHistoryPrev?: () => void
  onHistoryNext?: () => void
  onExternalEditor?: () => void
  onImagePasteTrigger?: () => void
  multiline?: boolean
  isActive?: boolean
}

/**
 * Readline / Emacs keyboard input handler bound to an `InputBufferController`.
 */
export function useTextInput({
  controller,
  onChange,
  onSubmit,
  onHistoryPrev,
  onHistoryNext,
  onExternalEditor,
  onImagePasteTrigger,
  multiline = true,
  isActive = true,
}: UseTextInputOptions): void {
  const sync = useCallback(() => {
    onChange(controller.text, controller.cursor)
  }, [controller, onChange])

  useInput(
    useCallback(
      (input: string, key: Key, event: InputEvent) => {
        if (!isActive || event.immediatePropagationStopped) return

        // Enter / Shift+Enter
        if (key.return) {
          if (multiline && (key.shift || key.meta)) {
            controller.insert('\n')
            sync()
          } else {
            onSubmit?.(controller.text)
          }
          event.stopImmediatePropagation()
          return
        }

        // Backspace & Delete
        if (key.backspace) {
          controller.backspace()
          sync()
          event.stopImmediatePropagation()
          return
        }
        if (key.delete) {
          controller.deleteForward()
          sync()
          event.stopImmediatePropagation()
          return
        }

        // Arrow navigation & history
        if (key.leftArrow) {
          if (key.meta || key.ctrl) controller.moveWordBackward()
          else controller.moveLeft()
          sync()
          event.stopImmediatePropagation()
          return
        }
        if (key.rightArrow) {
          if (key.meta || key.ctrl) controller.moveWordForward()
          else controller.moveRight()
          sync()
          event.stopImmediatePropagation()
          return
        }
        if (key.home) {
          controller.moveLineStart()
          sync()
          event.stopImmediatePropagation()
          return
        }
        if (key.end) {
          controller.moveLineEnd()
          sync()
          event.stopImmediatePropagation()
          return
        }
        if (key.upArrow) {
          onHistoryPrev?.()
          event.stopImmediatePropagation()
          return
        }
        if (key.downArrow) {
          onHistoryNext?.()
          event.stopImmediatePropagation()
          return
        }

        // Emacs Ctrl bindings
        if (key.ctrl) {
          const ch = input.toLowerCase()
          if (ch === 'a') {
            controller.moveLineStart()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'e') {
            controller.moveLineEnd()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'b') {
            controller.moveLeft()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'f') {
            controller.moveRight()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'k') {
            controller.killToEnd()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'u') {
            controller.killToStart()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'w') {
            controller.killWordBackward()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'y') {
            controller.yank()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === '_' || ch === '-') {
            controller.undo()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 's') {
            controller.toggleStash()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'g') {
            onExternalEditor?.()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'v') {
            onImagePasteTrigger?.()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'j' && multiline) {
            controller.insert('\n')
            sync()
            event.stopImmediatePropagation()
            return
          }
          return
        }

        // Meta word motions
        if (key.meta) {
          const ch = input.toLowerCase()
          if (ch === 'b') {
            controller.moveWordBackward()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'f') {
            controller.moveWordForward()
            sync()
            event.stopImmediatePropagation()
            return
          }
          if (ch === 'v') {
            onImagePasteTrigger?.()
            event.stopImmediatePropagation()
            return
          }
          return
        }

        if (key.escape || key.tab) return

        // Regular printable character / IME UTF-8 commit
        if (input && input.length > 0 && !/[\x00-\x1f\x7f]/.test(input)) {
          controller.insert(input)
          sync()
          event.stopImmediatePropagation()
        }
      },
      [
        isActive,
        multiline,
        controller,
        sync,
        onSubmit,
        onHistoryPrev,
        onHistoryNext,
        onExternalEditor,
        onImagePasteTrigger,
      ],
    ),
    { isActive },
  )
}

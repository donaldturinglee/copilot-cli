import { useCallback, useRef, useState } from 'react'
import type { InputEvent } from '../ink/events/input_event.js'
import type { Key } from '../ink/events/keyboard_event.js'
import { useInput } from '../ink/hooks/use_input.js'
import type { VimMode } from '../vim/types.js'
import { VimEngine } from '../vim/vim_engine.js'

export type UseVimInputOptions = {
  initialValue?: string
  initialMode?: VimMode
  isActive?: boolean
  onChange: (value: string, cursor: number, mode: VimMode) => void
  onSubmit?: (value: string) => void
  onModeChange?: (mode: VimMode) => void
}

export function useVimInput({
  initialValue = '',
  initialMode = 'INSERT',
  isActive = true,
  onChange,
  onSubmit,
  onModeChange,
}: UseVimInputOptions) {
  const engineRef = useRef<VimEngine | null>(null)
  if (!engineRef.current) {
    engineRef.current = new VimEngine(initialValue, initialMode)
  }
  const [, setTick] = useState(0)

  const sync = useCallback(
    (prevMode: VimMode) => {
      const eng = engineRef.current!
      if (eng.state.mode !== prevMode) {
        onModeChange?.(eng.state.mode)
      }
      onChange(eng.doc.text, eng.doc.cursor, eng.state.mode)
      setTick(t => t + 1)
    },
    [onChange, onModeChange],
  )

  useInput(
    useCallback(
      (input: string, key: Key, event: InputEvent) => {
        if (!isActive || event.immediatePropagationStopped) return
        const eng = engineRef.current!
        const prevMode = eng.state.mode

        if (key.return && key.shift && eng.state.mode === 'INSERT') {
          eng.handleKey({ char: '\n' })
          sync(prevMode)
          event.stopImmediatePropagation()
          return
        }

        if (key.leftArrow) {
          eng.doc.cursor = Math.max(0, eng.doc.cursor - 1)
          sync(prevMode)
          event.stopImmediatePropagation()
          return
        }
        if (key.rightArrow) {
          eng.doc.cursor = Math.min(eng.doc.text.length, eng.doc.cursor + 1)
          sync(prevMode)
          event.stopImmediatePropagation()
          return
        }

        const res = eng.handleKey({
          char: input,
          escape: key.escape,
          backspace: key.backspace,
          returnKey: key.return,
          ctrl: key.ctrl,
        })

        if (res.submitRequested) {
          onSubmit?.(eng.doc.text)
          event.stopImmediatePropagation()
          return
        }

        sync(prevMode)
        event.stopImmediatePropagation()
      },
      [isActive, onSubmit, sync],
    ),
    { isActive },
  )

  return {
    engine: engineRef.current,
    mode: engineRef.current.state.mode,
    modeLabel: engineRef.current.getModeLabel(),
    text: engineRef.current.doc.text,
    cursor: engineRef.current.doc.cursor,
    setDocument: (text: string, cursor?: number) => {
      engineRef.current!.setDocument(text, cursor)
      setTick(t => t + 1)
    },
  }
}

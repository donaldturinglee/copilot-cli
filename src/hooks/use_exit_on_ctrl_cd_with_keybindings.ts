import { useCallback, useState } from 'react'
import { useApp } from '../ink/hooks/use_app.js'
import { useKeybindings } from '../keybindings/use_keybinding.js'
import { DOUBLE_PRESS_TIMEOUT_MS, useDoublePress } from './use_double_press.js'
import type { ExitPromptState } from './use_exit_on_ctrl_cd.js'

export function useExitOnCtrlCDWithKeybindings(options?: {
  isActive?: boolean
  onExit?: () => void
  timeoutMs?: number
}): ExitPromptState {
  const { exit } = useApp()
  const [keyName, setKeyName] = useState<'ctrl+c' | 'ctrl+d' | null>(null)

  const doExit = useCallback(() => {
    if (options?.onExit) options.onExit()
    else exit()
  }, [options?.onExit, exit])

  const doublePress = useDoublePress(
    doExit,
    undefined,
    options?.timeoutMs ?? DOUBLE_PRESS_TIMEOUT_MS,
  )

  useKeybindings(
    {
      'app:interrupt': () => {
        setKeyName('ctrl+c')
        doublePress.trigger()
      },
      'app:exit': () => {
        setKeyName('ctrl+d')
        doublePress.trigger()
      },
    },
    { context: 'Global', isActive: options?.isActive ?? true },
  )

  return {
    pending: doublePress.pending,
    keyName: doublePress.pending ? keyName : null,
  }
}

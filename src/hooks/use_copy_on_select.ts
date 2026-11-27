import { useCallback } from 'react'
import { useSelection } from '../ink/hooks/use_selection.js'
import { setClipboard } from '../ink/termio/osc.js'
import { useKeybinding } from '../keybindings/use_keybinding.js'

export function useCopyOnSelect(options?: {
  onCopied?: (text: string) => void
  writeOsc52?: (seq: string) => void
  isActive?: boolean
}): { copySelection: () => string } {
  const { getSelectedText, clearSelection, hasSelection } = useSelection()

  const copySelection = useCallback((): string => {
    const text = getSelectedText()
    if (!text) return ''
    const seq = setClipboard(text)
    if (options?.writeOsc52) {
      options.writeOsc52(seq)
    } else if (process.stdout.isTTY) {
      process.stdout.write(seq)
    }
    options?.onCopied?.(text)
    clearSelection()
    return text
  }, [getSelectedText, clearSelection, options])

  useKeybinding(
    'selection:copy',
    () => {
      if (hasSelection) {
        copySelection()
      }
    },
    { context: 'Scroll', isActive: options?.isActive ?? true },
  )

  return { copySelection }
}

import { useKeybindings } from '../keybindings/use_keybinding.js'
import type { KeybindingContextName } from '../keybindings/types.js'

export type CommandKeybindingOptions = {
  context?: KeybindingContextName
  isActive?: boolean
}

export function useCommandKeybindings(
  handlers: Record<string, () => void>,
  options: CommandKeybindingOptions = {},
): void {
  useKeybindings(handlers, {
    context: options.context ?? 'Chat',
    isActive: options.isActive ?? true,
  })
}

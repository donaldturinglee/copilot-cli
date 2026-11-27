import { useKeybindings } from '../keybindings/use_keybinding.js'

export type GlobalKeybindingHandlers = {
  onRedraw?: () => void
  onToggleTodos?: () => void
  onToggleTranscript?: () => void
  onToggleTeammatePreview?: () => void
  onHistorySearch?: () => void
  onGlobalSearch?: () => void
  onQuickOpen?: () => void
  onToggleTerminal?: () => void
  isActive?: boolean
}

export function useGlobalKeybindings(handlers: GlobalKeybindingHandlers): void {
  const map: Record<string, () => void> = {}
  if (handlers.onRedraw) map['app:redraw'] = handlers.onRedraw
  if (handlers.onToggleTodos) map['app:toggleTodos'] = handlers.onToggleTodos
  if (handlers.onToggleTranscript) {
    map['app:toggleTranscript'] = handlers.onToggleTranscript
  }
  if (handlers.onToggleTeammatePreview) {
    map['app:toggleTeammatePreview'] = handlers.onToggleTeammatePreview
  }
  if (handlers.onHistorySearch) {
    map['history:search'] = handlers.onHistorySearch
  }
  if (handlers.onGlobalSearch) map['app:globalSearch'] = handlers.onGlobalSearch
  if (handlers.onQuickOpen) map['app:quickOpen'] = handlers.onQuickOpen
  if (handlers.onToggleTerminal) {
    map['app:toggleTerminal'] = handlers.onToggleTerminal
  }

  useKeybindings(map, {
    context: 'Global',
    isActive: handlers.isActive ?? true,
  })
}

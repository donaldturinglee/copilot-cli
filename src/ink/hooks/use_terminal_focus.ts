import { useTerminalFocusContext } from '../components/terminal_focus_context.js'

export function useTerminalFocus(): boolean {
  return useTerminalFocusContext()
}

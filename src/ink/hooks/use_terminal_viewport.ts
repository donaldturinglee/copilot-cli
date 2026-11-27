import {
  type TerminalSize,
  useTerminalSizeContext,
} from '../components/terminal_size_context.js'

export function useTerminalViewport(): TerminalSize {
  return useTerminalSizeContext()
}

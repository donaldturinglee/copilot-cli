import { useContext, useEffect, useState } from 'react'
import { TerminalSizeContext } from '../ink/components/terminal_size_context.js'
import { getTerminalSize } from '../utilities/terminal.js'

export type TerminalDimensions = {
  columns: number
  rows: number
}

/**
 * Subscribe to live terminal viewport dimensions (`columns`, `rows`).
 * Prefers Ink's `TerminalSizeContext` and stays reactive to `process.stdout`
 * `resize` events when running in an interactive terminal.
 */
export function useTerminalSize(): TerminalDimensions {
  const ctxSize = useContext(TerminalSizeContext)
  const [fallbackSize, setFallbackSize] = useState<TerminalDimensions>(() =>
    getTerminalSize(),
  )

  useEffect(() => {
    if (ctxSize !== null) return
    if (!process.stdout || typeof process.stdout.on !== 'function') return
    const handleResize = (): void => {
      setFallbackSize(getTerminalSize())
    }
    process.stdout.on('resize', handleResize)
    return () => {
      process.stdout.off('resize', handleResize)
    }
  }, [ctxSize !== null])

  return ctxSize ?? fallbackSize
}

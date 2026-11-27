import { useCallback, useEffect, useRef } from 'react'
import {
  createPasteChip,
  shouldFoldPaste,
  type StoredPaste,
} from '../utilities/paste_store.js'

export const PASTE_DEBOUNCE_MS = 100

export type PasteHandlerResult =
  | { kind: 'empty_paste' }
  | { kind: 'inline'; text: string }
  | { kind: 'folded'; chip: StoredPaste }

/**
 * Pure coalescer that batches rapid paste chunks within a 100ms debounce
 * window and folds large pastes into `[Pasted text #N +X lines]` chips.
 */
export class PasteDebouncer {
  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly delayMs: number
  private readonly onFlush: (result: PasteHandlerResult) => void

  constructor(
    onFlush: (result: PasteHandlerResult) => void,
    delayMs = PASTE_DEBOUNCE_MS,
  ) {
    this.onFlush = onFlush
    this.delayMs = delayMs
  }

  push(chunk: string, isEmptyPaste = false): void {
    if (isEmptyPaste && chunk.length === 0 && this.buffer.length === 0) {
      this.onFlush({ kind: 'empty_paste' })
      return
    }
    this.buffer += chunk
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.flushNow()
    }, this.delayMs)
  }

  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const text = this.buffer
    this.buffer = ''
    if (!text) {
      this.onFlush({ kind: 'empty_paste' })
      return
    }
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (shouldFoldPaste(normalized)) {
      const chip = createPasteChip(normalized)
      this.onFlush({ kind: 'folded', chip })
    } else {
      this.onFlush({ kind: 'inline', text: normalized })
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.buffer = ''
  }
}

export function usePasteHandler(options: {
  onInsertText: (text: string) => void
  onEmptyPaste?: () => void
  delayMs?: number
}) {
  const onInsertRef = useRef(options.onInsertText)
  const onEmptyRef = useRef(options.onEmptyPaste)
  onInsertRef.current = options.onInsertText
  onEmptyRef.current = options.onEmptyPaste

  const debouncerRef = useRef<PasteDebouncer | null>(null)
  if (!debouncerRef.current) {
    debouncerRef.current = new PasteDebouncer(result => {
      if (result.kind === 'empty_paste') {
        onEmptyRef.current?.()
      } else if (result.kind === 'folded') {
        onInsertRef.current(result.chip.token)
      } else {
        onInsertRef.current(result.text)
      }
    }, options.delayMs ?? PASTE_DEBOUNCE_MS)
  }

  useEffect(() => {
    const d = debouncerRef.current
    return () => {
      d?.dispose()
    }
  }, [])

  const handlePaste = useCallback((chunk: string, isEmptyPaste = false) => {
    debouncerRef.current?.push(chunk, isEmptyPaste)
  }, [])

  const flushPaste = useCallback(() => {
    debouncerRef.current?.flushNow()
  }, [])

  return { handlePaste, flushPaste }
}

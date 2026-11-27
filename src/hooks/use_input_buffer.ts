import { useCallback, useRef, useState } from 'react'

export const MAX_UNDO_DEPTH = 50
export const MAX_KILL_RING = 30

const ATOMIC_CHIP_RE =
  /\[Image #\d+\]|\[Pasted text #\d+(?: \+\d+ lines)?\]/g

export type BufferSnapshot = {
  text: string
  cursor: number
}

export type ChipSpan = {
  start: number
  end: number
  token: string
}

export function findAtomicChipSpans(text: string): ChipSpan[] {
  const spans: ChipSpan[] = []
  for (const m of text.matchAll(ATOMIC_CHIP_RE)) {
    const start = m.index ?? 0
    spans.push({ start, end: start + m[0].length, token: m[0] })
  }
  return spans
}

/**
 * Pure state transition helpers for the 50-step undo + Emacs Kill Ring +
 * `Ctrl+S` stash input buffer. Exported for direct unit testing as well as
 * React hook usage.
 */
export class InputBufferController {
  text: string
  cursor: number
  private undoStack: BufferSnapshot[] = []
  private redoStack: BufferSnapshot[] = []
  private killRing: string[] = []
  private stash: BufferSnapshot | null = null

  constructor(initialText = '', initialCursor?: number) {
    this.text = initialText
    this.cursor =
      initialCursor !== undefined
        ? Math.max(0, Math.min(initialCursor, initialText.length))
        : initialText.length
  }

  private pushUndo(): void {
    const top = this.undoStack[this.undoStack.length - 1]
    if (top && top.text === this.text && top.cursor === this.cursor) return
    this.undoStack.push({ text: this.text, cursor: this.cursor })
    if (this.undoStack.length > MAX_UNDO_DEPTH) {
      this.undoStack.shift()
    }
    this.redoStack = []
  }

  private pushKill(killed: string): void {
    if (!killed) return
    this.killRing.push(killed)
    if (this.killRing.length > MAX_KILL_RING) {
      this.killRing.shift()
    }
  }

  setValue(text: string, cursor = text.length, recordUndo = true): void {
    if (recordUndo && text !== this.text) this.pushUndo()
    this.text = text
    this.cursor = Math.max(0, Math.min(cursor, text.length))
  }

  setCursor(cursor: number): void {
    this.cursor = Math.max(0, Math.min(cursor, this.text.length))
  }

  insert(str: string): void {
    if (!str) return
    this.pushUndo()
    this.text =
      this.text.slice(0, this.cursor) + str + this.text.slice(this.cursor)
    this.cursor += str.length
  }

  /**
   * Delete backwards, atomically deleting any `[Image #N]` or `[Pasted text #N]`
   * chip whose end aligns with the cursor.
   */
  backspace(): void {
    if (this.cursor <= 0) return
    this.pushUndo()
    const spans = findAtomicChipSpans(this.text)
    const chip = spans.find(
      s => this.cursor > s.start && this.cursor <= s.end,
    )
    if (chip) {
      this.text = this.text.slice(0, chip.start) + this.text.slice(chip.end)
      this.cursor = chip.start
      return
    }
    this.text =
      this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor)
    this.cursor -= 1
  }

  deleteForward(): void {
    if (this.cursor >= this.text.length) return
    this.pushUndo()
    const spans = findAtomicChipSpans(this.text)
    const chip = spans.find(
      s => this.cursor >= s.start && this.cursor < s.end,
    )
    if (chip) {
      this.text = this.text.slice(0, chip.start) + this.text.slice(chip.end)
      this.cursor = chip.start
      return
    }
    this.text =
      this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1)
  }

  moveLeft(): void {
    if (this.cursor <= 0) return
    const next = this.cursor - 1
    const chip = findAtomicChipSpans(this.text).find(
      s => next > s.start && next < s.end,
    )
    this.cursor = chip ? chip.start : next
  }

  moveRight(): void {
    if (this.cursor >= this.text.length) return
    const next = this.cursor + 1
    const chip = findAtomicChipSpans(this.text).find(
      s => next > s.start && next < s.end,
    )
    this.cursor = chip ? chip.end : next
  }

  moveLineStart(): void {
    const nl = this.text.lastIndexOf('\n', this.cursor - 1)
    this.cursor = nl === -1 ? 0 : nl + 1
  }

  moveLineEnd(): void {
    const nl = this.text.indexOf('\n', this.cursor)
    this.cursor = nl === -1 ? this.text.length : nl
  }

  moveWordBackward(): void {
    let pos = this.cursor
    while (pos > 0 && /\s/.test(this.text[pos - 1]!)) pos--
    while (pos > 0 && !/\s/.test(this.text[pos - 1]!)) pos--
    this.cursor = pos
  }

  moveWordForward(): void {
    let pos = this.cursor
    while (pos < this.text.length && /\s/.test(this.text[pos]!)) pos++
    while (pos < this.text.length && !/\s/.test(this.text[pos]!)) pos++
    this.cursor = pos
  }

  /** Emacs `Ctrl+K`: kill to end of line and store in Kill Ring. */
  killToEnd(): string {
    const nl = this.text.indexOf('\n', this.cursor)
    const end = nl === -1 ? this.text.length : nl === this.cursor ? nl + 1 : nl
    if (end <= this.cursor) return ''
    this.pushUndo()
    const killed = this.text.slice(this.cursor, end)
    this.pushKill(killed)
    this.text = this.text.slice(0, this.cursor) + this.text.slice(end)
    return killed
  }

  /** Emacs `Ctrl+U`: kill to start of line and store in Kill Ring. */
  killToStart(): string {
    const nl = this.text.lastIndexOf('\n', this.cursor - 1)
    const start = nl === -1 ? 0 : nl + 1
    if (this.cursor <= start) return ''
    this.pushUndo()
    const killed = this.text.slice(start, this.cursor)
    this.pushKill(killed)
    this.text = this.text.slice(0, start) + this.text.slice(this.cursor)
    this.cursor = start
    return killed
  }

  /** Emacs `Ctrl+W`: kill previous word and store in Kill Ring. */
  killWordBackward(): string {
    const oldCursor = this.cursor
    this.moveWordBackward()
    const start = this.cursor
    if (oldCursor <= start) return ''
    this.cursor = oldCursor
    this.pushUndo()
    const killed = this.text.slice(start, oldCursor)
    this.pushKill(killed)
    this.text = this.text.slice(0, start) + this.text.slice(oldCursor)
    this.cursor = start
    return killed
  }

  /** Emacs `Ctrl+Y`: yank most recently killed text from Kill Ring. */
  yank(): string {
    const top = this.killRing[this.killRing.length - 1]
    if (!top) return ''
    this.insert(top)
    return top
  }

  /** Undo up to 50 steps (`Ctrl+_`). */
  undo(): boolean {
    const prev = this.undoStack.pop()
    if (!prev) return false
    this.redoStack.push({ text: this.text, cursor: this.cursor })
    this.text = prev.text
    this.cursor = prev.cursor
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push({ text: this.text, cursor: this.cursor })
    this.text = next.text
    this.cursor = next.cursor
    return true
  }

  /** `Ctrl+S`: stash current draft or restore previously stashed draft. */
  toggleStash(): 'stashed' | 'restored' | 'noop' {
    if (this.text.length > 0) {
      this.stash = { text: this.text, cursor: this.cursor }
      this.pushUndo()
      this.text = ''
      this.cursor = 0
      return 'stashed'
    }
    if (this.stash) {
      this.pushUndo()
      this.text = this.stash.text
      this.cursor = this.stash.cursor
      this.stash = null
      return 'restored'
    }
    return 'noop'
  }

  hasStash(): boolean {
    return this.stash !== null
  }

  getKillRing(): readonly string[] {
    return this.killRing
  }

  getUndoDepth(): number {
    return this.undoStack.length
  }
}

export function useInputBuffer(initialValue = '') {
  const controllerRef = useRef<InputBufferController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new InputBufferController(initialValue)
  }
  const [, setVersion] = useState(0)
  const notify = useCallback(() => setVersion(v => v + 1), [])

  return {
    controller: controllerRef.current,
    text: controllerRef.current.text,
    cursor: controllerRef.current.cursor,
    hasStash: controllerRef.current.hasStash(),
    notify,
  }
}

import { applyVimKey, type VimKeyInput } from './transitions.js'
import {
  createInitialPersistentState,
  createInitialVimState,
  type PersistentState,
  type RecordedChange,
  type VimDocument,
  type VimMode,
  type VimState,
} from './types.js'

const MAX_VIM_UNDO = 50

/**
 * Stateful Vim editing controller wrapping the pure 11-state transition FSM
 * with a 50-step undo/redo stack and `.` dot-repeat replay.
 */
export class VimEngine {
  doc: VimDocument
  state: VimState
  persistent: PersistentState
  private undoStack: VimDocument[] = []
  private redoStack: VimDocument[] = []

  constructor(initialText = '', initialMode: VimMode = 'INSERT') {
    this.doc = {
      text: initialText,
      cursor: initialMode === 'INSERT' ? initialText.length : 0,
    }
    this.state = createInitialVimState(initialMode)
    this.persistent = createInitialPersistentState()
  }

  setDocument(text: string, cursor?: number): void {
    this.doc = {
      text,
      cursor:
        cursor !== undefined
          ? Math.max(0, Math.min(cursor, text.length))
          : text.length,
    }
  }

  private pushUndo(snapshot: VimDocument): void {
    const top = this.undoStack[this.undoStack.length - 1]
    if (top && top.text === snapshot.text && top.cursor === snapshot.cursor) {
      return
    }
    this.undoStack.push({ ...snapshot })
    if (this.undoStack.length > MAX_VIM_UNDO) {
      this.undoStack.shift()
    }
    this.redoStack = []
  }

  handleKey(input: VimKeyInput): { submitRequested: boolean } {
    const beforeDoc = { ...this.doc }
    const outcome = applyVimKey(this.doc, this.state, this.persistent, input)

    if (outcome.undoRequested) {
      this.undo()
      return { submitRequested: false }
    }
    if (outcome.redoRequested) {
      this.redo()
      return { submitRequested: false }
    }
    if (outcome.dotRepeatRequested) {
      this.replayLastChange()
      return { submitRequested: false }
    }

    if (outcome.mutated) {
      this.pushUndo(beforeDoc)
    }

    this.doc = outcome.doc
    this.state = outcome.state
    this.persistent = outcome.persistent
    return { submitRequested: Boolean(outcome.submitRequested) }
  }

  /**
   * Feed a sequence of Vim key tokens (e.g. `['2','d','w']` or `['c','i','"','x','<Esc>']`).
   */
  feedKeys(keys: readonly (string | VimKeyInput)[]): void {
    for (const k of keys) {
      if (typeof k === 'string') {
        if (k === '<Esc>') this.handleKey({ char: '', escape: true })
        else if (k === '<BS>') this.handleKey({ char: '', backspace: true })
        else if (k === '<CR>') this.handleKey({ char: '', returnKey: true })
        else this.handleKey({ char: k })
      } else {
        this.handleKey(k)
      }
    }
  }

  undo(): boolean {
    const prev = this.undoStack.pop()
    if (!prev) return false
    this.redoStack.push({ ...this.doc })
    this.doc = prev
    this.state = createInitialVimState('NORMAL')
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    this.undoStack.push({ ...this.doc })
    this.doc = next
    this.state = createInitialVimState('NORMAL')
    return true
  }

  private replayLastChange(): void {
    const change = this.persistent.lastChange
    if (!change) return
    const savedChange: RecordedChange = { ...change }
    const keys: VimKeyInput[] = []
    const pushChars = (s: string) => {
      for (const ch of s) keys.push({ char: ch })
    }

    switch (savedChange.kind) {
      case 'operator_motion': {
        const opCh =
          savedChange.op === 'delete'
            ? 'd'
            : savedChange.op === 'change'
              ? 'c'
              : 'y'
        if (savedChange.count > 1) pushChars(String(savedChange.count))
        pushChars(opCh)
        pushChars(savedChange.motion)
        if (savedChange.insertedText) {
          pushChars(savedChange.insertedText)
          keys.push({ char: '', escape: true })
        }
        break
      }
      case 'operator_find': {
        const opCh =
          savedChange.op === 'delete'
            ? 'd'
            : savedChange.op === 'change'
              ? 'c'
              : 'y'
        if (savedChange.count > 1) pushChars(String(savedChange.count))
        pushChars(opCh)
        pushChars(savedChange.find)
        pushChars(savedChange.char)
        if (savedChange.insertedText) {
          pushChars(savedChange.insertedText)
          keys.push({ char: '', escape: true })
        }
        break
      }
      case 'operator_textobj': {
        const opCh =
          savedChange.op === 'delete'
            ? 'd'
            : savedChange.op === 'change'
              ? 'c'
              : 'y'
        if (savedChange.count > 1) pushChars(String(savedChange.count))
        pushChars(opCh)
        pushChars(savedChange.scope === 'inner' ? 'i' : 'a')
        pushChars(savedChange.objChar)
        if (savedChange.insertedText) {
          pushChars(savedChange.insertedText)
          keys.push({ char: '', escape: true })
        }
        break
      }
      case 'operator_line': {
        const opCh =
          savedChange.op === 'delete'
            ? 'd'
            : savedChange.op === 'change'
              ? 'c'
              : 'y'
        if (savedChange.count > 1) pushChars(String(savedChange.count))
        pushChars(opCh + opCh)
        if (savedChange.insertedText) {
          pushChars(savedChange.insertedText)
          keys.push({ char: '', escape: true })
        }
        break
      }
      case 'simple': {
        if (savedChange.count > 1) pushChars(String(savedChange.count))
        pushChars(savedChange.cmd)
        if (savedChange.insertedText) {
          pushChars(savedChange.insertedText)
          keys.push({ char: '', escape: true })
        }
        break
      }
      case 'replace': {
        if (savedChange.count > 1) pushChars(String(savedChange.count))
        pushChars('r')
        pushChars(savedChange.char)
        break
      }
      case 'indent': {
        if (savedChange.count > 1) pushChars(String(savedChange.count))
        pushChars(savedChange.dir + savedChange.dir)
        break
      }
      case 'insert': {
        pushChars('i')
        pushChars(savedChange.insertedText)
        keys.push({ char: '', escape: true })
        break
      }
    }

    const beforeDoc = { ...this.doc }
    let didMutate = false
    for (const k of keys) {
      const res = applyVimKey(this.doc, this.state, this.persistent, k)
      if (res.mutated) didMutate = true
      this.doc = res.doc
      this.state = res.state
      this.persistent = res.persistent
    }
    if (didMutate) {
      this.pushUndo(beforeDoc)
    }
    this.persistent = { ...this.persistent, lastChange: savedChange }
  }

  getModeLabel(): string {
    if (this.state.mode === 'INSERT') return 'INSERT'
    const cmd = this.state.command
    switch (cmd.type) {
      case 'idle':
        return 'NORMAL'
      case 'count':
        return `NORMAL ${cmd.digits}`
      case 'operator':
        return `NORMAL ${cmd.count > 1 ? cmd.count : ''}${cmd.op[0]}`
      case 'operatorCount':
        return `NORMAL ${cmd.op[0]}${cmd.digits}`
      case 'operatorFind':
        return `NORMAL ${cmd.op[0]}${cmd.find}`
      case 'operatorTextObj':
        return `NORMAL ${cmd.op[0]}${cmd.scope === 'inner' ? 'i' : 'a'}`
      case 'find':
        return `NORMAL ${cmd.find}`
      case 'g':
        return 'NORMAL g'
      case 'operatorG':
        return `NORMAL ${cmd.op[0]}g`
      case 'replace':
        return 'NORMAL r'
      case 'indent':
        return `NORMAL ${cmd.dir}`
    }
  }
}

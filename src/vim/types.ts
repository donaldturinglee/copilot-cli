export type VimMode = 'INSERT' | 'NORMAL'

export type Operator = 'delete' | 'change' | 'yank'

export type FindType = 'f' | 'F' | 't' | 'T'

export type TextObjectScope = 'inner' | 'around'

export type IndentDirection = '>' | '<'

/**
 * Exact 11-state Vim NORMAL-mode command FSM.
 */
export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count1: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | {
      type: 'operatorTextObj'
      op: Operator
      count: number
      scope: TextObjectScope
    }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: IndentDirection; count: number }

export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }

export type RecordedChange =
  | {
      kind: 'operator_motion'
      op: Operator
      count: number
      motion: string
      insertedText?: string
    }
  | {
      kind: 'operator_find'
      op: Operator
      count: number
      find: FindType
      char: string
      insertedText?: string
    }
  | {
      kind: 'operator_textobj'
      op: Operator
      count: number
      scope: TextObjectScope
      objChar: string
      insertedText?: string
    }
  | {
      kind: 'operator_line'
      op: Operator
      count: number
      insertedText?: string
    }
  | {
      kind: 'simple'
      cmd: 'x' | 'X' | '~' | 'J' | 'D' | 'C' | 's' | 'S' | 'o' | 'O'
      count: number
      insertedText?: string
    }
  | {
      kind: 'replace'
      count: number
      char: string
    }
  | {
      kind: 'indent'
      dir: IndentDirection
      count: number
    }
  | {
      kind: 'insert'
      insertedText: string
    }

export type PersistentState = {
  lastChange: RecordedChange | null
  lastFind: { type: FindType; char: string } | null
  register: string
  registerIsLinewise: boolean
}

export type VimDocument = {
  text: string
  cursor: number
}

export function createInitialVimState(mode: VimMode = 'INSERT'): VimState {
  if (mode === 'INSERT') {
    return { mode: 'INSERT', insertedText: '' }
  }
  return { mode: 'NORMAL', command: { type: 'idle' } }
}

export function createInitialPersistentState(): PersistentState {
  return {
    lastChange: null,
    lastFind: null,
    register: '',
    registerIsLinewise: false,
  }
}

export function charToOperator(ch: string): Operator | null {
  if (ch === 'd') return 'delete'
  if (ch === 'c') return 'change'
  if (ch === 'y') return 'yank'
  return null
}

export function isFindChar(ch: string): ch is FindType {
  return ch === 'f' || ch === 'F' || ch === 't' || ch === 'T'
}

export const SIMPLE_MOTIONS = new Set([
  'h',
  'j',
  'k',
  'l',
  'w',
  'b',
  'e',
  'W',
  'B',
  'E',
  '0',
  '^',
  '$',
  'G',
])

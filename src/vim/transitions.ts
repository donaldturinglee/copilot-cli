import {
  expandRangeAcrossChips,
  findEnclosingChip,
  snapCursorOutOfChip,
} from './image_chips.js'
import {
  clampNormalCursor,
  getLineBounds,
  resolveFindMotion,
  resolveMotion,
} from './motions.js'
import {
  applyIndent,
  applyLineOperator,
  applyOperatorRange,
  applyPaste,
} from './operators.js'
import { resolveTextObject } from './text_objects.js'
import {
  charToOperator,
  type CommandState,
  isFindChar,
  type Operator,
  type PersistentState,
  type RecordedChange,
  SIMPLE_MOTIONS,
  type VimDocument,
  type VimState,
} from './types.js'

export type VimKeyInput = {
  char: string
  escape?: boolean
  backspace?: boolean
  returnKey?: boolean
  ctrl?: boolean
}

export type VimTransitionOutcome = {
  doc: VimDocument
  state: VimState
  persistent: PersistentState
  mutated: boolean
  undoRequested?: boolean
  redoRequested?: boolean
  dotRepeatRequested?: boolean
  submitRequested?: boolean
}

const IDLE: CommandState = { type: 'idle' }

function normal(command: CommandState = IDLE): VimState {
  return { mode: 'NORMAL', command }
}

function insert(): VimState {
  return { mode: 'INSERT', insertedText: '' }
}

function executeOperatorMotion(
  doc: VimDocument,
  persistent: PersistentState,
  op: Operator,
  count: number,
  motion: string,
): VimTransitionOutcome {
  const m = resolveMotion(doc.text, doc.cursor, motion, count, true)
  let start = Math.min(doc.cursor, m.cursor)
  let end = Math.max(doc.cursor, m.cursor)
  if (m.inclusive && !m.linewise && end < doc.text.length) {
    end = Math.min(doc.text.length, end + 1)
  }
  const res = applyOperatorRange(doc, persistent, op, start, end, m.linewise)
  const change: RecordedChange | null =
    op === 'yank'
      ? persistent.lastChange
      : { kind: 'operator_motion', op, count, motion }
  return {
    doc: res.doc,
    state: res.enterInsert ? insert() : normal(),
    persistent: { ...res.persistent, lastChange: change },
    mutated: res.mutated,
  }
}

/**
 * Pure exhaustive 11-state Vim FSM transition function.
 * Handles all 11 NORMAL `CommandState` variants (`idle`, `count`, `operator`,
 * `operatorCount`, `operatorFind`, `operatorTextObj`, `find`, `g`, `operatorG`,
 * `replace`, `indent`) plus `INSERT` mode.
 */
export function applyVimKey(
  doc: VimDocument,
  state: VimState,
  persistent: PersistentState,
  key: VimKeyInput,
): VimTransitionOutcome {
  const ch = key.char

  // Global ESC -> return to NORMAL idle (and finalize any pending change's insertedText)
  if (key.escape) {
    if (state.mode === 'INSERT') {
      const nextCursor =
        doc.cursor > 0
          ? snapCursorOutOfChip(doc.text, doc.cursor - 1, 'left')
          : 0
      const updatedChange: RecordedChange | null =
        persistent.lastChange &&
        'insertedText' in persistent.lastChange &&
        persistent.lastChange.insertedText === undefined
          ? { ...persistent.lastChange, insertedText: state.insertedText }
          : state.insertedText.length > 0
            ? { kind: 'insert', insertedText: state.insertedText }
            : persistent.lastChange
      return {
        doc: {
          text: doc.text,
          cursor: clampNormalCursor(doc.text, nextCursor),
        },
        state: normal(),
        persistent: { ...persistent, lastChange: updatedChange },
        mutated: false,
      }
    }
    return { doc, state: normal(), persistent, mutated: false }
  }

  // INSERT mode
  if (state.mode === 'INSERT') {
    if (key.returnKey) {
      return { doc, state, persistent, mutated: false, submitRequested: true }
    }
    if (key.backspace) {
      if (doc.cursor <= 0) {
        return { doc, state, persistent, mutated: false }
      }
      const chip = findEnclosingChip(doc.text, doc.cursor - 1, true)
      if (chip) {
        const nextText =
          doc.text.slice(0, chip.start) + doc.text.slice(chip.end)
        return {
          doc: { text: nextText, cursor: chip.start },
          state,
          persistent,
          mutated: true,
        }
      }
      const nextText =
        doc.text.slice(0, doc.cursor - 1) + doc.text.slice(doc.cursor)
      return {
        doc: { text: nextText, cursor: doc.cursor - 1 },
        state: {
          mode: 'INSERT',
          insertedText: state.insertedText.slice(0, -1),
        },
        persistent,
        mutated: true,
      }
    }
    if (ch && !key.ctrl) {
      const nextText =
        doc.text.slice(0, doc.cursor) + ch + doc.text.slice(doc.cursor)
      return {
        doc: { text: nextText, cursor: doc.cursor + ch.length },
        state: {
          mode: 'INSERT',
          insertedText: state.insertedText + ch,
        },
        persistent,
        mutated: true,
      }
    }
    return { doc, state, persistent, mutated: false }
  }

  // NORMAL mode — Ctrl+R redo
  if (key.ctrl && ch.toLowerCase() === 'r') {
    return { doc, state: normal(), persistent, mutated: false, redoRequested: true }
  }

  if (key.returnKey) {
    return { doc, state: normal(), persistent, mutated: false, submitRequested: true }
  }

  const cmd = state.command

  switch (cmd.type) {
    // 1. IDLE
    case 'idle':
      return handleNormalIdleOrCount(doc, persistent, ch, 1, false)

    // 2. COUNT
    case 'count': {
      if (/^[0-9]$/.test(ch)) {
        return {
          doc,
          state: normal({ type: 'count', digits: cmd.digits + ch }),
          persistent,
          mutated: false,
        }
      }
      const count = Math.max(1, parseInt(cmd.digits, 10) || 1)
      return handleNormalIdleOrCount(doc, persistent, ch, count, true)
    }

    // 3. OPERATOR (`d`, `c`, `y`)
    case 'operator': {
      if (/^[1-9]$/.test(ch)) {
        return {
          doc,
          state: normal({
            type: 'operatorCount',
            op: cmd.op,
            count1: cmd.count,
            digits: ch,
          }),
          persistent,
          mutated: false,
        }
      }
      return handleOperatorFollowup(doc, persistent, cmd.op, cmd.count, ch)
    }

    // 4. OPERATOR_COUNT (`2d3...` or `d2...`)
    case 'operatorCount': {
      if (/^[0-9]$/.test(ch)) {
        return {
          doc,
          state: normal({
            ...cmd,
            digits: cmd.digits + ch,
          }),
          persistent,
          mutated: false,
        }
      }
      const total = cmd.count1 * Math.max(1, parseInt(cmd.digits, 10) || 1)
      return handleOperatorFollowup(doc, persistent, cmd.op, total, ch)
    }

    // 5. OPERATOR_FIND (`df`, `ct`, `dF`, `cT`)
    case 'operatorFind': {
      const f = resolveFindMotion(doc.text, doc.cursor, cmd.find, ch, cmd.count)
      const nextPersistent: PersistentState = {
        ...persistent,
        lastFind: { type: cmd.find, char: ch },
      }
      if (!f.found) {
        return { doc, state: normal(), persistent: nextPersistent, mutated: false }
      }
      const start = Math.min(doc.cursor, f.cursor)
      let end = Math.max(doc.cursor, f.cursor)
      if (f.inclusive && end < doc.text.length) end += 1
      const res = applyOperatorRange(doc, nextPersistent, cmd.op, start, end, false)
      const change: RecordedChange | null =
        cmd.op === 'yank'
          ? res.persistent.lastChange
          : {
              kind: 'operator_find',
              op: cmd.op,
              count: cmd.count,
              find: cmd.find,
              char: ch,
            }
      return {
        doc: res.doc,
        state: res.enterInsert ? insert() : normal(),
        persistent: { ...res.persistent, lastChange: change },
        mutated: res.mutated,
      }
    }

    // 6. OPERATOR_TEXT_OBJ (`ci"`, `daw`, `yi(`, etc.)
    case 'operatorTextObj': {
      const range = resolveTextObject(doc.text, doc.cursor, cmd.scope, ch)
      if (!range) {
        return { doc, state: normal(), persistent, mutated: false }
      }
      const res = applyOperatorRange(
        doc,
        persistent,
        cmd.op,
        range.start,
        range.end,
        false,
      )
      const change: RecordedChange | null =
        cmd.op === 'yank'
          ? res.persistent.lastChange
          : {
              kind: 'operator_textobj',
              op: cmd.op,
              count: cmd.count,
              scope: cmd.scope,
              objChar: ch,
            }
      return {
        doc: res.doc,
        state: res.enterInsert ? insert() : normal(),
        persistent: { ...res.persistent, lastChange: change },
        mutated: res.mutated,
      }
    }

    // 7. FIND (`f`, `F`, `t`, `T`)
    case 'find': {
      const f = resolveFindMotion(doc.text, doc.cursor, cmd.find, ch, cmd.count)
      return {
        doc: f.found ? { ...doc, cursor: f.cursor } : doc,
        state: normal(),
        persistent: {
          ...persistent,
          lastFind: { type: cmd.find, char: ch },
        },
        mutated: false,
      }
    }

    // 8. G (`gg`)
    case 'g': {
      if (ch === 'g') {
        const m = resolveMotion(doc.text, doc.cursor, 'gg', cmd.count, false)
        return {
          doc: { ...doc, cursor: m.cursor },
          state: normal(),
          persistent,
          mutated: false,
        }
      }
      return { doc, state: normal(), persistent, mutated: false }
    }

    // 9. OPERATOR_G (`dgg`, `cgg`, `ygg`)
    case 'operatorG': {
      if (ch === 'g') {
        return executeOperatorMotion(doc, persistent, cmd.op, cmd.count, 'gg')
      }
      return { doc, state: normal(), persistent, mutated: false }
    }

    // 10. REPLACE (`r<ch>`)
    case 'replace': {
      if (!ch || ch.length !== 1 || doc.text.length === 0) {
        return { doc, state: normal(), persistent, mutated: false }
      }
      // Protect atomic `[Image #N]` chips from character overwrite
      if (findEnclosingChip(doc.text, doc.cursor, true)) {
        return { doc, state: normal(), persistent, mutated: false }
      }
      const count = Math.min(cmd.count, doc.text.length - doc.cursor)
      const replacement = ch.repeat(count)
      const nextText =
        doc.text.slice(0, doc.cursor) +
        replacement +
        doc.text.slice(doc.cursor + count)
      return {
        doc: {
          text: nextText,
          cursor: Math.min(nextText.length - 1, doc.cursor + count - 1),
        },
        state: normal(),
        persistent: {
          ...persistent,
          lastChange: { kind: 'replace', count: cmd.count, char: ch },
        },
        mutated: true,
      }
    }

    // 11. INDENT (`>>`, `<<`)
    case 'indent': {
      if (ch === cmd.dir) {
        const nextDoc = applyIndent(doc, cmd.dir, cmd.count)
        return {
          doc: nextDoc,
          state: normal(),
          persistent: {
            ...persistent,
            lastChange: { kind: 'indent', dir: cmd.dir, count: cmd.count },
          },
          mutated: true,
        }
      }
      return { doc, state: normal(), persistent, mutated: false }
    }
  }
}

function handleOperatorFollowup(
  doc: VimDocument,
  persistent: PersistentState,
  op: Operator,
  count: number,
  ch: string,
): VimTransitionOutcome {
  // Doubled operator: `dd`, `cc`, `yy`
  if (charToOperator(ch) === op) {
    const res = applyLineOperator(doc, persistent, op, count)
    const change: RecordedChange | null =
      op === 'yank'
        ? res.persistent.lastChange
        : { kind: 'operator_line', op, count }
    return {
      doc: res.doc,
      state: res.enterInsert ? insert() : normal(),
      persistent: { ...res.persistent, lastChange: change },
      mutated: res.mutated,
    }
  }

  // Text object prefix: `i` (inner) / `a` (around)
  if (ch === 'i' || ch === 'a') {
    return {
      doc,
      state: normal({
        type: 'operatorTextObj',
        op,
        count,
        scope: ch === 'i' ? 'inner' : 'around',
      }),
      persistent,
      mutated: false,
    }
  }

  // Find motion after operator: `df`, `ct`, etc.
  if (isFindChar(ch)) {
    return {
      doc,
      state: normal({ type: 'operatorFind', op, count, find: ch }),
      persistent,
      mutated: false,
    }
  }

  // `g` prefix after operator (`dgg`)
  if (ch === 'g') {
    return {
      doc,
      state: normal({ type: 'operatorG', op, count }),
      persistent,
      mutated: false,
    }
  }

  if (SIMPLE_MOTIONS.has(ch)) {
    return executeOperatorMotion(doc, persistent, op, count, ch)
  }

  return { doc, state: normal(), persistent, mutated: false }
}

function handleNormalIdleOrCount(
  doc: VimDocument,
  persistent: PersistentState,
  ch: string,
  count: number,
  hasCount: boolean,
): VimTransitionOutcome {
  // Start a count prefix (1-9)
  if (!hasCount && /^[1-9]$/.test(ch)) {
    return {
      doc,
      state: normal({ type: 'count', digits: ch }),
      persistent,
      mutated: false,
    }
  }

  // Undo & Dot-repeat
  if (ch === 'u') {
    return { doc, state: normal(), persistent, mutated: false, undoRequested: true }
  }
  if (ch === '.') {
    return {
      doc,
      state: normal(),
      persistent,
      mutated: false,
      dotRepeatRequested: true,
    }
  }

  // Operators `d`, `c`, `y`
  const op = charToOperator(ch)
  if (op) {
    return {
      doc,
      state: normal({ type: 'operator', op, count }),
      persistent,
      mutated: false,
    }
  }

  // Character find `f`, `F`, `t`, `T`
  if (isFindChar(ch)) {
    return {
      doc,
      state: normal({ type: 'find', find: ch, count }),
      persistent,
      mutated: false,
    }
  }

  // Repeat last find `;` / `,`
  if ((ch === ';' || ch === ',') && persistent.lastFind) {
    const inv: Record<'f' | 'F' | 't' | 'T', 'f' | 'F' | 't' | 'T'> = {
      f: 'F',
      F: 'f',
      t: 'T',
      T: 't',
    }
    const findType =
      ch === ';' ? persistent.lastFind.type : inv[persistent.lastFind.type]
    const f = resolveFindMotion(
      doc.text,
      doc.cursor,
      findType,
      persistent.lastFind.char,
      count,
    )
    return {
      doc: f.found ? { ...doc, cursor: f.cursor } : doc,
      state: normal(),
      persistent,
      mutated: false,
    }
  }

  // `g`, `r`, `>`, `<`
  if (ch === 'g') {
    return { doc, state: normal({ type: 'g', count }), persistent, mutated: false }
  }
  if (ch === 'r') {
    return {
      doc,
      state: normal({ type: 'replace', count }),
      persistent,
      mutated: false,
    }
  }
  if (ch === '>' || ch === '<') {
    return {
      doc,
      state: normal({ type: 'indent', dir: ch, count }),
      persistent,
      mutated: false,
    }
  }

  // Simple motions
  if (SIMPLE_MOTIONS.has(ch)) {
    const m = resolveMotion(doc.text, doc.cursor, ch, count, false)
    return {
      doc: { ...doc, cursor: m.cursor },
      state: normal(),
      persistent,
      mutated: false,
    }
  }

  // Enter INSERT transitions
  if (ch === 'i') {
    const pos = snapCursorOutOfChip(doc.text, doc.cursor, 'left')
    return { doc: { ...doc, cursor: pos }, state: insert(), persistent, mutated: false }
  }
  if (ch === 'a') {
    const chip = findEnclosingChip(doc.text, doc.cursor, true)
    const pos = chip
      ? chip.end
      : Math.min(doc.text.length, doc.cursor + (doc.text.length > 0 ? 1 : 0))
    return { doc: { ...doc, cursor: pos }, state: insert(), persistent, mutated: false }
  }
  if (ch === 'I') {
    const { start, end } = getLineBounds(doc.text, doc.cursor)
    let p = start
    while (p < end && /\s/.test(doc.text[p]!)) p++
    return { doc: { ...doc, cursor: p }, state: insert(), persistent, mutated: false }
  }
  if (ch === 'A') {
    const { end } = getLineBounds(doc.text, doc.cursor)
    return { doc: { ...doc, cursor: end }, state: insert(), persistent, mutated: false }
  }
  if (ch === 'o' || ch === 'O') {
    const { start, end } = getLineBounds(doc.text, doc.cursor)
    const insertAt = ch === 'o' ? end : start
    const nextText =
      ch === 'o'
        ? `${doc.text.slice(0, insertAt)}\n${doc.text.slice(insertAt)}`
        : `${doc.text.slice(0, insertAt)}\n${doc.text.slice(insertAt)}`
    const nextCursor = ch === 'o' ? insertAt + 1 : insertAt
    return {
      doc: { text: nextText, cursor: nextCursor },
      state: insert(),
      persistent: {
        ...persistent,
        lastChange: { kind: 'simple', cmd: ch, count },
      },
      mutated: true,
    }
  }

  // Single-key edits: `x`, `X`, `D`, `C`, `s`, `S`, `~`, `J`, `p`, `P`
  if (ch === 'x') {
    if (doc.text.length === 0) return { doc, state: normal(), persistent, mutated: false }
    const range = expandRangeAcrossChips(
      doc.text,
      doc.cursor,
      Math.min(doc.text.length, doc.cursor + count),
    )
    const res = applyOperatorRange(doc, persistent, 'delete', range.start, range.end, false)
    return {
      doc: res.doc,
      state: normal(),
      persistent: {
        ...res.persistent,
        lastChange: { kind: 'simple', cmd: 'x', count },
      },
      mutated: res.mutated,
    }
  }

  if (ch === 'X') {
    if (doc.cursor <= 0) return { doc, state: normal(), persistent, mutated: false }
    const range = expandRangeAcrossChips(
      doc.text,
      Math.max(0, doc.cursor - count),
      doc.cursor,
    )
    const res = applyOperatorRange(doc, persistent, 'delete', range.start, range.end, false)
    return {
      doc: res.doc,
      state: normal(),
      persistent: {
        ...res.persistent,
        lastChange: { kind: 'simple', cmd: 'X', count },
      },
      mutated: res.mutated,
    }
  }

  if (ch === 'D' || ch === 'C') {
    const { end } = getLineBounds(doc.text, doc.cursor)
    const op: Operator = ch === 'D' ? 'delete' : 'change'
    const res = applyOperatorRange(doc, persistent, op, doc.cursor, end, false)
    return {
      doc: res.doc,
      state: res.enterInsert ? insert() : normal(),
      persistent: {
        ...res.persistent,
        lastChange: { kind: 'simple', cmd: ch, count },
      },
      mutated: res.mutated,
    }
  }

  if (ch === 's') {
    const range = expandRangeAcrossChips(
      doc.text,
      doc.cursor,
      Math.min(doc.text.length, doc.cursor + count),
    )
    const res = applyOperatorRange(doc, persistent, 'change', range.start, range.end, false)
    return {
      doc: res.doc,
      state: insert(),
      persistent: {
        ...res.persistent,
        lastChange: { kind: 'simple', cmd: 's', count },
      },
      mutated: res.mutated,
    }
  }

  if (ch === 'S') {
    const res = applyLineOperator(doc, persistent, 'change', count)
    return {
      doc: res.doc,
      state: insert(),
      persistent: {
        ...res.persistent,
        lastChange: { kind: 'simple', cmd: 'S', count },
      },
      mutated: res.mutated,
    }
  }

  if (ch === '~') {
    if (doc.text.length === 0 || findEnclosingChip(doc.text, doc.cursor, true)) {
      return { doc, state: normal(), persistent, mutated: false }
    }
    const end = Math.min(doc.text.length, doc.cursor + count)
    const toggled = Array.from(doc.text.slice(doc.cursor, end))
      .map(c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()))
      .join('')
    const nextText =
      doc.text.slice(0, doc.cursor) + toggled + doc.text.slice(end)
    return {
      doc: { text: nextText, cursor: clampNormalCursor(nextText, end) },
      state: normal(),
      persistent: {
        ...persistent,
        lastChange: { kind: 'simple', cmd: '~', count },
      },
      mutated: true,
    }
  }

  if (ch === 'J') {
    const { end } = getLineBounds(doc.text, doc.cursor)
    if (end >= doc.text.length) {
      return { doc, state: normal(), persistent, mutated: false }
    }
    let nextStart = end + 1
    while (nextStart < doc.text.length && /[ \t]/.test(doc.text[nextStart]!)) {
      nextStart++
    }
    const nextText = `${doc.text.slice(0, end)} ${doc.text.slice(nextStart)}`
    return {
      doc: { text: nextText, cursor: end },
      state: normal(),
      persistent: {
        ...persistent,
        lastChange: { kind: 'simple', cmd: 'J', count },
      },
      mutated: true,
    }
  }

  if (ch === 'p' || ch === 'P') {
    const res = applyPaste(doc, persistent, ch === 'P', count)
    return {
      doc: res.doc,
      state: normal(),
      persistent,
      mutated: res.mutated,
    }
  }

  return { doc, state: normal(), persistent, mutated: false }
}

import { expandRangeAcrossChips, snapCursorOutOfChip } from './image_chips.js'
import { clampNormalCursor, getLineBounds } from './motions.js'
import type { IndentDirection, Operator, PersistentState, VimDocument } from './types.js'

export type OperatorExecutionResult = {
  doc: VimDocument
  persistent: PersistentState
  enterInsert: boolean
  mutated: boolean
}

/**
 * Apply `delete`, `change`, or `yank` over `[start, end)` (charwise) while
 * protecting atomic `[Image #N]` chips from partial slicing.
 */
export function applyOperatorRange(
  doc: VimDocument,
  persistent: PersistentState,
  op: Operator,
  rawStart: number,
  rawEnd: number,
  linewise = false,
): OperatorExecutionResult {
  let start = Math.min(rawStart, rawEnd)
  let end = Math.max(rawStart, rawEnd)

  if (linewise) {
    const firstLine = getLineBounds(doc.text, start)
    const lastLine = getLineBounds(doc.text, Math.max(start, end))
    start = firstLine.start
    end = lastLine.end
    // Include trailing newline if present, otherwise leading newline if not first line
    let captured = doc.text.slice(start, end)
    if (op === 'yank') {
      return {
        doc,
        persistent: {
          ...persistent,
          register: captured,
          registerIsLinewise: true,
        },
        enterInsert: false,
        mutated: false,
      }
    }

    if (op === 'change') {
      // Keep the line itself empty and enter INSERT mode
      const nextText = doc.text.slice(0, start) + doc.text.slice(end)
      return {
        doc: { text: nextText, cursor: start },
        persistent: {
          ...persistent,
          register: captured,
          registerIsLinewise: true,
        },
        enterInsert: true,
        mutated: true,
      }
    }

    // Delete linewise (dd / d2j / etc.)
    let delStart = start
    let delEnd = end
    if (delEnd < doc.text.length && doc.text[delEnd] === '\n') {
      delEnd += 1
    } else if (delStart > 0 && doc.text[delStart - 1] === '\n') {
      delStart -= 1
    }
    captured = doc.text.slice(start, end)
    const nextText = doc.text.slice(0, delStart) + doc.text.slice(delEnd)
    const nextCursor = clampNormalCursor(nextText, Math.min(start, nextText.length))
    return {
      doc: {
        text: nextText,
        cursor: snapCursorOutOfChip(nextText, nextCursor, 'left'),
      },
      persistent: {
        ...persistent,
        register: captured,
        registerIsLinewise: true,
      },
      enterInsert: false,
      mutated: true,
    }
  }

  // Charwise range with atomic chip protection
  const expanded = expandRangeAcrossChips(doc.text, start, end)
  start = expanded.start
  end = expanded.end
  const captured = doc.text.slice(start, end)

  if (op === 'yank') {
    return {
      doc,
      persistent: {
        ...persistent,
        register: captured,
        registerIsLinewise: false,
      },
      enterInsert: false,
      mutated: false,
    }
  }

  const nextText = doc.text.slice(0, start) + doc.text.slice(end)
  const enterInsert = op === 'change'
  const nextCursor = enterInsert
    ? start
    : clampNormalCursor(nextText, start)

  return {
    doc: {
      text: nextText,
      cursor: enterInsert
        ? nextCursor
        : snapCursorOutOfChip(nextText, nextCursor, 'left'),
    },
    persistent: {
      ...persistent,
      register: captured,
      registerIsLinewise: false,
    },
    enterInsert,
    mutated: true,
  }
}

/**
 * Execute `dd`, `cc`, `yy` for `count` lines starting at the cursor's line.
 */
export function applyLineOperator(
  doc: VimDocument,
  persistent: PersistentState,
  op: Operator,
  count: number,
): OperatorExecutionResult {
  const lines = doc.text.split('\n')
  const { start: firstStart } = getLineBounds(doc.text, doc.cursor)
  // Find line index
  let lineIdx = 0
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    if (off === firstStart) {
      lineIdx = i
      break
    }
    off += lines[i]!.length + 1
  }
  const lastLineIdx = Math.min(lines.length - 1, lineIdx + Math.max(1, count) - 1)
  let endOffset = firstStart
  for (let i = lineIdx; i <= lastLineIdx; i++) {
    endOffset += lines[i]!.length + (i < lastLineIdx ? 1 : 0)
  }
  return applyOperatorRange(doc, persistent, op, firstStart, endOffset, true)
}

/**
 * Paste register contents (`p` after cursor/line, `P` before cursor/line).
 */
export function applyPaste(
  doc: VimDocument,
  persistent: PersistentState,
  before: boolean,
  count: number,
): { doc: VimDocument; mutated: boolean } {
  if (!persistent.register) return { doc, mutated: false }
  const repeats = Math.max(1, count)

  if (persistent.registerIsLinewise) {
    const { start, end } = getLineBounds(doc.text, doc.cursor)
    const block = Array.from({ length: repeats }, () => persistent.register).join(
      '\n',
    )
    if (before) {
      const nextText =
        doc.text.length === 0
          ? block
          : `${doc.text.slice(0, start)}${block}\n${doc.text.slice(start)}`
      return {
        doc: { text: nextText, cursor: start },
        mutated: true,
      }
    }
    const nextText =
      doc.text.length === 0
        ? block
        : `${doc.text.slice(0, end)}\n${block}${doc.text.slice(end)}`
    const nextCursor = doc.text.length === 0 ? 0 : end + 1
    return {
      doc: { text: nextText, cursor: nextCursor },
      mutated: true,
    }
  }

  const insertStr = persistent.register.repeat(repeats)
  const insertPos =
    doc.text.length === 0
      ? 0
      : before
        ? snapCursorOutOfChip(doc.text, doc.cursor, 'left')
        : snapCursorOutOfChip(doc.text, Math.min(doc.text.length, doc.cursor + 1), 'right')
  const nextText =
    doc.text.slice(0, insertPos) + insertStr + doc.text.slice(insertPos)
  const nextCursor = clampNormalCursor(
    nextText,
    insertPos + insertStr.length - 1,
  )
  return {
    doc: { text: nextText, cursor: nextCursor },
    mutated: true,
  }
}

/**
 * Indent (`>>`) or dedent (`<<`) `count` lines by 2 spaces.
 */
export function applyIndent(
  doc: VimDocument,
  dir: IndentDirection,
  count: number,
): VimDocument {
  const lines = doc.text.split('\n')
  const { start: curLineStart } = getLineBounds(doc.text, doc.cursor)
  let lineIdx = 0
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    if (off === curLineStart) {
      lineIdx = i
      break
    }
    off += lines[i]!.length + 1
  }

  const endIdx = Math.min(lines.length - 1, lineIdx + Math.max(1, count) - 1)
  for (let i = lineIdx; i <= endIdx; i++) {
    if (dir === '>') {
      lines[i] = `  ${lines[i]!}`
    } else {
      lines[i] = lines[i]!.replace(/^ {1,2}|\t/, '')
    }
  }
  const nextText = lines.join('\n')
  let newStart = 0
  for (let i = 0; i < lineIdx; i++) newStart += lines[i]!.length + 1
  return { text: nextText, cursor: newStart }
}

import type { Diff, Patch } from './frame.js'

/**
 * Single-pass peephole optimizer for terminal render patches.
 *
 * Eliminates redundant cursor movement, coalesces adjacent `stdout` writes,
 * drops no-op zero moves, folds consecutive relative `cursorMove` ops, and
 * removes duplicate style/hyperlink/cursor visibility transitions.
 */
export function optimizeDiff(diff: Diff): Diff {
  if (diff.length <= 1) {
    if (diff.length === 1) {
      const p = diff[0]!
      if (p.type === 'stdout' && p.content.length === 0) return []
      if (p.type === 'cursorMove' && p.x === 0 && p.y === 0) return []
    }
    return diff
  }

  const out: Patch[] = []

  for (let i = 0; i < diff.length; i++) {
    const op = diff[i]!

    // Drop empty stdout or zero-delta cursorMove
    if (op.type === 'stdout' && op.content.length === 0) continue
    if (op.type === 'cursorMove' && op.x === 0 && op.y === 0) continue

    const prev = out[out.length - 1]
    if (!prev) {
      out.push(op)
      continue
    }

    // Coalesce adjacent stdout patches
    if (prev.type === 'stdout' && op.type === 'stdout') {
      out[out.length - 1] = {
        type: 'stdout',
        content: prev.content + op.content,
      }
      continue
    }

    // Fold consecutive relative cursor moves
    if (prev.type === 'cursorMove' && op.type === 'cursorMove') {
      const nx = prev.x + op.x
      const ny = prev.y + op.y
      if (nx === 0 && ny === 0) {
        out.pop()
      } else {
        out[out.length - 1] = { type: 'cursorMove', x: nx, y: ny }
      }
      continue
    }

    // Absolute cursorTo supersedes an immediately preceding cursorMove or cursorTo
    if (
      op.type === 'cursorTo' &&
      (prev.type === 'cursorMove' || prev.type === 'cursorTo')
    ) {
      out[out.length - 1] = op
      continue
    }

    // Consecutive style ops: only the last takes effect before text
    if (prev.type === 'style' && op.type === 'style') {
      out[out.length - 1] = op
      continue
    }

    // Consecutive hyperlink ops: only the last takes effect before text
    if (prev.type === 'hyperlink' && op.type === 'hyperlink') {
      out[out.length - 1] = op
      continue
    }

    // Adjacent opposite cursor visibility toggles cancel out
    if (
      (prev.type === 'cursorHide' && op.type === 'cursorShow') ||
      (prev.type === 'cursorShow' && op.type === 'cursorHide')
    ) {
      out.pop()
      continue
    }

    // Identical cursor visibility toggles deduplicate
    if (
      (prev.type === 'cursorHide' && op.type === 'cursorHide') ||
      (prev.type === 'cursorShow' && op.type === 'cursorShow')
    ) {
      continue
    }

    out.push(op)
  }

  return out
}

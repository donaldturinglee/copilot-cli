/**
 * Structured unified diff computation and line-count analytics built on the
 * `diff` library.
 */

import { structuredPatch, type StructuredPatchHunk } from 'diff'

export type { StructuredPatchHunk }

export const CONTEXT_LINES = 3
export const DIFF_TIMEOUT_MS = 5_000

/**
 * Offsets `oldStart` and `newStart` across every hunk in a structured patch
 * (used when diffing a slice of a very large file).
 */
export function adjustHunkLineNumbers(
  hunks: readonly StructuredPatchHunk[],
  lineOffset: number,
): StructuredPatchHunk[] {
  if (lineOffset === 0) {
    return hunks.map(h => ({ ...h, lines: [...h.lines] }))
  }
  return hunks.map(hunk => ({
    ...hunk,
    oldStart: hunk.oldStart + lineOffset,
    newStart: hunk.newStart + lineOffset,
    lines: [...hunk.lines],
  }))
}

/**
 * Counts added and removed lines across structured patch hunks.
 */
export function countLinesChanged(hunks: readonly StructuredPatchHunk[]): {
  added: number
  removed: number
} {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        added++
      } else if (line.startsWith('-')) {
        removed++
      }
    }
  }
  return { added, removed }
}

/**
 * Computes structured patch hunks between `oldContent` and `newContent`.
 */
export function getPatchFromContents(params: {
  filePath: string
  oldContent: string
  newContent: string
  ignoreWhitespace?: boolean
  context?: number
}): StructuredPatchHunk[] {
  const patch = structuredPatch(
    params.filePath,
    params.filePath,
    params.oldContent,
    params.newContent,
    undefined,
    undefined,
    {
      context: params.context ?? CONTEXT_LINES,
      ignoreWhitespace: params.ignoreWhitespace,
      timeout: DIFF_TIMEOUT_MS,
    },
  )
  return patch?.hunks ?? []
}

export interface FileEditOp {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/**
 * Computes display patch hunks for one or more string replacements applied to
 * `fileContents`.
 */
export function getPatchForDisplay(params: {
  filePath: string
  fileContents: string
  edits: readonly FileEditOp[]
}): StructuredPatchHunk[] {
  let updated = params.fileContents
  for (const edit of params.edits) {
    if (edit.old_string === '') {
      updated = edit.new_string
    } else if (edit.replace_all) {
      updated = updated.replaceAll(edit.old_string, edit.new_string)
    } else {
      updated = updated.replace(edit.old_string, () => edit.new_string)
    }
  }
  return getPatchFromContents({
    filePath: params.filePath,
    oldContent: params.fileContents,
    newContent: updated,
  })
}

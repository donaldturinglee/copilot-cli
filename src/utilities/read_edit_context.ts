/**
 * Reads a bounded line window around a target edit location for concise
 * post-edit snippets and diagnostics.
 */

import { readFileInRange } from './read_file_in_range.js'

export interface EditContextSlice {
  content: string
  startLine: number
  endLine: number
  totalLines: number
}

/**
 * Reads `[targetLine - radius, targetLine + radius]` (1-based) from `filePath`.
 */
export async function readEditContext(
  filePath: string,
  targetLine: number,
  radius = 4,
): Promise<EditContextSlice> {
  const startLine = Math.max(1, targetLine - radius)
  const limit = radius * 2 + 1
  const result = await readFileInRange(filePath, {
    offset: startLine,
    limit,
  })
  return {
    content: result.content,
    startLine,
    endLine: startLine + Math.max(0, result.lineCount - 1),
    totalLines: result.totalLines,
  }
}

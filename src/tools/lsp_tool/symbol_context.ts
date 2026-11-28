/**
 * Extracts the identifier or operator token under `(line0, char0)` within the
 * first 64KB of a source file for `LSPTool` summary captions.
 */

import { readFileSync } from 'fs'
import { expandPath } from '../../utilities/path.js'
import { truncate } from '../../utilities/truncate.js'

const MAX_READ_BYTES = 64 * 1024
const SYMBOL_TOKEN_RE = /[\w$'!]+|[+\-*/%&|^~<>=]+/g

/**
 * Returns the truncated symbol name at 0-based `(line0, char0)`, or `null` if
 * none is found.
 */
export function getSymbolAtPosition(
  filePath: string,
  line0: number,
  char0: number,
): string | null {
  try {
    const raw = readFileSync(expandPath(filePath), 'utf8').slice(
      0,
      MAX_READ_BYTES,
    )
    const lines = raw.split(/\r?\n/)
    if (line0 < 0 || line0 >= lines.length) {
      return null
    }
    const lineText = lines[line0]!
    SYMBOL_TOKEN_RE.lastIndex = 0
    let match = SYMBOL_TOKEN_RE.exec(lineText)
    while (match !== null) {
      const start = match.index
      const end = start + match[0].length
      if (char0 >= start && char0 <= end) {
        return truncate(match[0], 30)
      }
      match = SYMBOL_TOKEN_RE.exec(lineText)
    }
  } catch {
    // Ignore unreadable files
  }
  return null
}

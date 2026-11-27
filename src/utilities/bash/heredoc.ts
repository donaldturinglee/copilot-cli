/**
 * Heredoc extraction and safe single-quoted `cat` heredoc validation.
 */

import { isSafeQuotedCatHeredocSubstitution } from './ast.js'

export interface ExtractedHeredoc {
  delimiter: string
  quoted: boolean
  stripTabs: boolean
  body: string
}

const HEREDOC_HEADER_RE = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g

/**
 * Extracts heredoc descriptors and bodies from a shell script.
 */
export function extractHeredocs(command: string): ExtractedHeredoc[] {
  const results: ExtractedHeredoc[] = []
  const lines = command.split(/\r?\n/)
  let lineIdx = 0

  while (lineIdx < lines.length) {
    const line = lines[lineIdx]!
    const matches = [...line.matchAll(HEREDOC_HEADER_RE)]
    lineIdx++
    for (const m of matches) {
      const stripTabs = m[1] === '-'
      const quoted = m[2] === "'" || m[2] === '"'
      const delimiter = m[3]!
      const bodyLines: string[] = []
      while (lineIdx < lines.length) {
        const candidate = lines[lineIdx]!
        lineIdx++
        const normalized = stripTabs ? candidate.replace(/^\t+/, '') : candidate
        if (normalized === delimiter) {
          break
        }
        bodyLines.push(candidate)
      }
      results.push({
        delimiter,
        quoted,
        stripTabs,
        body: bodyLines.join('\n'),
      })
    }
  }

  return results
}

export { isSafeQuotedCatHeredocSubstitution }

import { readdirSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import type { SuggestionItem } from './command_suggestions.js'

/**
 * Shell Tab path / directory completion for `!` bash mode or path tokens.
 */
export function getDirectorySuggestions(
  partialPath: string,
  cwd: string,
  limit = 10,
): SuggestionItem[] {
  const clean = partialPath.trim()
  const hasTrailingSlash = clean.endsWith('/') || clean.endsWith('\\')
  const searchDir = clean
    ? hasTrailingSlash
      ? resolve(cwd, clean)
      : resolve(cwd, dirname(clean))
    : cwd
  const prefix = hasTrailingSlash ? '' : basename(clean).toLowerCase()
  const baseRel = clean
    ? hasTrailingSlash
      ? clean
      : dirname(clean) === '.'
        ? ''
        : `${dirname(clean).replace(/\\/g, '/')}/`
    : ''

  try {
    const entries = readdirSync(searchDir, { withFileTypes: true })
    const out: SuggestionItem[] = []
    for (const entry of entries) {
      if (prefix && !entry.name.toLowerCase().startsWith(prefix)) continue
      const suffix = entry.isDirectory() ? '/' : ''
      const relPath = `${baseRel}${entry.name}${suffix}`
      out.push({
        id: `dir:${join(searchDir, entry.name)}`,
        displayText: relPath,
        insertText: relPath,
        description: entry.isDirectory() ? 'directory' : 'file',
        kind: entry.isDirectory() ? 'directory' : 'file',
        score: entry.isDirectory() ? 80 : 60,
      })
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}

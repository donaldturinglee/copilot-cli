import { truncate } from '../utilities/truncate.js'
import type { TextWrapMode } from './styles.js'
import { wrapAnsi, wrapAnsiLines, type WrappedLine } from './wrap_ansi.js'

const MAX_WRAP_CACHE = 2048
const wrapCache = new Map<string, string>()

export function wrapText(
  text: string,
  maxWidth: number,
  wrapType: TextWrapMode = 'wrap',
): string {
  const safeWidth = Math.max(1, Math.floor(maxWidth))
  const cacheKey = `${wrapType}|${safeWidth}|${text}`
  const cached = wrapCache.get(cacheKey)
  if (cached !== undefined) return cached

  let output: string
  if (wrapType === 'wrap') {
    output = wrapAnsi(text, safeWidth, { hard: true, wordWrap: true, trim: false })
  } else {
    const position =
      wrapType === 'truncate-start'
        ? 'start'
        : wrapType === 'middle' || wrapType === 'truncate-middle'
          ? 'middle'
          : 'end'
    output = text
      .split('\n')
      .map(line => truncate(line, safeWidth, { position }))
      .join('\n')
  }

  if (wrapCache.size >= MAX_WRAP_CACHE) {
    wrapCache.clear()
  }
  wrapCache.set(cacheKey, output)
  return output
}

export function wrapTextWithMetadata(
  text: string,
  maxWidth: number,
  wrapType: TextWrapMode = 'wrap',
): WrappedLine[] {
  const safeWidth = Math.max(1, Math.floor(maxWidth))
  if (wrapType === 'wrap') {
    return wrapAnsiLines(text, safeWidth, { hard: true, wordWrap: true, trim: false })
  }
  const wrapped = wrapText(text, safeWidth, wrapType)
  return wrapped.split('\n').map(line => ({ text: line, softWrapped: false }))
}

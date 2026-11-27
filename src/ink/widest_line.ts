import { cachedStringWidth } from './line_width_cache.js'

export function widestLine(text: string): number {
  let maxWidth = 0
  const lines = text.split('\n')
  for (const line of lines) {
    const w = cachedStringWidth(line)
    if (w > maxWidth) maxWidth = w
  }
  return maxWidth
}

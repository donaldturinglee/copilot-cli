import { stringWidth } from './string_width.js'

const MAX_CACHE_ENTRIES = 4096
const widthCache = new Map<string, number>()

export function cachedStringWidth(str: string): number {
  if (str.length === 0) return 0
  const hit = widthCache.get(str)
  if (hit !== undefined) return hit
  const w = stringWidth(str)
  if (widthCache.size >= MAX_CACHE_ENTRIES) {
    widthCache.clear()
  }
  widthCache.set(str, w)
  return w
}

export function clearLineWidthCache(): void {
  widthCache.clear()
}

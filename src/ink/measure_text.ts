import { widestLine } from './widest_line.js'

export type MeasuredText = {
  width: number
  height: number
}

const MAX_CACHE = 2048
const measureCache = new Map<string, MeasuredText>()

export function measureText(text: string): MeasuredText {
  if (text.length === 0) {
    return { width: 0, height: 0 }
  }
  const hit = measureCache.get(text)
  if (hit) return hit

  const width = widestLine(text)
  const height = text.split('\n').length
  const result = { width, height }

  if (measureCache.size >= MAX_CACHE) {
    measureCache.clear()
  }
  measureCache.set(text, result)
  return result
}

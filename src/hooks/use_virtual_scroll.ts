import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
} from 'react'
import type { ScrollBoxHandle } from '../ink/components/scroll_box.js'
import type { DOMElement } from '../ink/dom.js'

export const DEFAULT_ESTIMATE = 3
export const OVERSCAN_ROWS = 80
export const COLD_START_COUNT = 30
/** 40-line scroll quantization bin (half of OVERSCAN_ROWS). */
export const SCROLL_QUANTUM = OVERSCAN_ROWS >> 1
export const PESSIMISTIC_HEIGHT = 1
export const MAX_MOUNTED_ITEMS = 300
export const SLIDE_STEP = 25

export type VirtualScrollRange = {
  startIndex: number
  endIndex: number
  topSpacer: number
  bottomSpacer: number
  totalHeight: number
  offsets: Float64Array
}

/**
 * Pure range calculator for virtualized transcripts enforcing:
 * - 80-line overscan above & below viewport
 * - 40-line scrollTop quantization
 * - 300-item hard cap on mounted React fibers
 */
export function computeVirtualWindow(params: {
  itemCount: number
  scrollTop: number
  viewportHeight: number
  stickyBottom: boolean
  heights: readonly number[]
}): VirtualScrollRange {
  const { itemCount, scrollTop, viewportHeight, stickyBottom, heights } = params
  const offsets = new Float64Array(itemCount + 1)
  for (let i = 0; i < itemCount; i++) {
    offsets[i + 1] = offsets[i]! + Math.max(1, heights[i] ?? DEFAULT_ESTIMATE)
  }
  const totalHeight = offsets[itemCount]!

  if (itemCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacer: 0,
      bottomSpacer: 0,
      totalHeight: 0,
      offsets,
    }
  }

  if (viewportHeight <= 0) {
    const start = Math.max(0, itemCount - COLD_START_COUNT)
    return {
      startIndex: start,
      endIndex: itemCount,
      topSpacer: offsets[start]!,
      bottomSpacer: 0,
      totalHeight,
      offsets,
    }
  }

  const effectiveScroll = stickyBottom
    ? Math.max(0, totalHeight - viewportHeight)
    : Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight)))

  // Quantize scrollTop into 40-line bins so wheel ticks don't thrash React reconciles
  const quantizedTop =
    Math.floor(effectiveScroll / SCROLL_QUANTUM) * SCROLL_QUANTUM
  const windowTop = Math.max(0, quantizedTop - OVERSCAN_ROWS)
  const windowBottom = quantizedTop + viewportHeight + OVERSCAN_ROWS

  // Binary search for first item whose bottom edge > windowTop
  let lo = 0
  let hi = itemCount - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid + 1]! <= windowTop) lo = mid + 1
    else hi = mid
  }
  let startIndex = lo

  // Advance endIndex until item top >= windowBottom or MAX_MOUNTED_ITEMS reached
  let endIndex = startIndex
  while (
    endIndex < itemCount &&
    offsets[endIndex]! < windowBottom &&
    endIndex - startIndex < MAX_MOUNTED_ITEMS
  ) {
    endIndex++
  }

  if (endIndex === startIndex && itemCount > 0) {
    endIndex = Math.min(itemCount, startIndex + 1)
  }

  // If sticky at bottom, prefer anchoring window at the tail
  if (stickyBottom && endIndex < itemCount) {
    endIndex = itemCount
    startIndex = Math.max(0, endIndex - MAX_MOUNTED_ITEMS)
    while (
      startIndex < endIndex - 1 &&
      totalHeight - offsets[startIndex + 1]! >= viewportHeight + OVERSCAN_ROWS
    ) {
      startIndex++
    }
  }

  return {
    startIndex,
    endIndex,
    topSpacer: offsets[startIndex]!,
    bottomSpacer: Math.max(0, totalHeight - offsets[endIndex]!),
    totalHeight,
    offsets,
  }
}

export type VirtualScrollResult = {
  range: readonly [number, number]
  topSpacer: number
  bottomSpacer: number
  totalHeight: number
  offsets: Float64Array
  measureRef: (key: string) => (el: DOMElement | null) => void
  scrollToIndex: (index: number) => void
  getItemHeight: (index: number) => number | undefined
}

export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  columns: number,
  viewportHeight: number,
  scrollTop: number,
  stickyBottom = true,
): VirtualScrollResult {
  const heightCache = useRef(new Map<string, number>())
  const itemRefs = useRef(new Map<string, DOMElement>())
  const refFactoryCache = useRef(
    new Map<string, (el: DOMElement | null) => void>(),
  )
  const prevColsRef = useRef(columns)

  // Scale cached item heights proportionally on terminal width resize
  if (prevColsRef.current !== columns && columns > 0) {
    const ratio = prevColsRef.current / columns
    prevColsRef.current = columns
    for (const [k, h] of heightCache.current) {
      heightCache.current.set(k, Math.max(1, Math.round(h * ratio)))
    }
  }

  const heights = itemKeys.map(
    k => heightCache.current.get(k) ?? DEFAULT_ESTIMATE,
  )

  const win = computeVirtualWindow({
    itemCount: itemKeys.length,
    scrollTop,
    viewportHeight,
    stickyBottom,
    heights,
  })

  useLayoutEffect(() => {
    for (const [key, el] of itemRefs.current) {
      const h = el.layoutNode?.getComputedHeight()
      if (h !== undefined && h > 0) {
        heightCache.current.set(key, h)
      }
    }
  })

  const measureRef = useCallback((key: string) => {
    let fn = refFactoryCache.current.get(key)
    if (!fn) {
      fn = (el: DOMElement | null) => {
        if (el) itemRefs.current.set(key, el)
        else itemRefs.current.delete(key)
      }
      refFactoryCache.current.set(key, fn)
    }
    return fn
  }, [])

  const scrollToIndex = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, itemKeys.length - 1))
      const y = win.offsets[clamped] ?? 0
      scrollRef.current?.scrollTo(y)
    },
    [itemKeys.length, win.offsets, scrollRef],
  )

  const getItemHeight = useCallback(
    (index: number) => {
      const k = itemKeys[index]
      return k ? heightCache.current.get(k) : undefined
    },
    [itemKeys],
  )

  return {
    range: [win.startIndex, win.endIndex] as const,
    topSpacer: win.topSpacer,
    bottomSpacer: win.bottomSpacer,
    totalHeight: win.totalHeight,
    offsets: win.offsets,
    measureRef,
    scrollToIndex,
    getItemHeight,
  }
}

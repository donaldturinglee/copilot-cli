import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import type { DOMElement } from '../dom.js'
import type { Styles } from '../styles.js'

export type ScrollBoxHandle = {
  scrollTo: (row: number) => void
  scrollBy: (delta: number) => void
  scrollToBottom: () => void
  scrollToTop: () => void
  getScrollTop: () => number
  getMaxScrollTop: () => number
  getElement: () => DOMElement | null
}

export type ScrollBoxProps = Styles & {
  children?: React.ReactNode
  scrollTop?: number
  stickyBottom?: boolean
  onScroll?: (scrollTop: number) => void
}

/**
 * Scrollable viewport container that clips children to its bounds and emits
 * hardware DECSTBM `scrollHint` deltas for zero-flicker 60fps scrolling.
 */
export const ScrollBox = forwardRef<ScrollBoxHandle, ScrollBoxProps>(
  function ScrollBox(
    { children, scrollTop, stickyBottom = false, onScroll, ...styleProps },
    ref,
  ) {
    const domRef = useRef<DOMElement | null>(null)

    useImperativeHandle(
      ref,
      () => ({
        scrollTo(row: number) {
          const el = domRef.current
          if (!el?.internal_scrollState) return
          const st = el.internal_scrollState
          const maxScroll = Math.max(0, st.contentHeight - st.viewportHeight)
          st.stickyBottom = false
          st.scrollTop = Math.max(0, Math.min(Math.floor(row), maxScroll))
          el.dirty = true
          onScroll?.(st.scrollTop)
        },
        scrollBy(delta: number) {
          const el = domRef.current
          if (!el?.internal_scrollState) return
          const st = el.internal_scrollState
          const maxScroll = Math.max(0, st.contentHeight - st.viewportHeight)
          st.stickyBottom = false
          st.scrollTop = Math.max(
            0,
            Math.min(st.scrollTop + Math.floor(delta), maxScroll),
          )
          el.dirty = true
          onScroll?.(st.scrollTop)
        },
        scrollToBottom() {
          const el = domRef.current
          if (!el?.internal_scrollState) return
          const st = el.internal_scrollState
          st.stickyBottom = true
          st.scrollTop = Math.max(0, st.contentHeight - st.viewportHeight)
          el.dirty = true
          onScroll?.(st.scrollTop)
        },
        scrollToTop() {
          const el = domRef.current
          if (!el?.internal_scrollState) return
          const st = el.internal_scrollState
          st.stickyBottom = false
          st.scrollTop = 0
          el.dirty = true
          onScroll?.(0)
        },
        getScrollTop() {
          return domRef.current?.internal_scrollState?.scrollTop ?? 0
        },
        getMaxScrollTop() {
          const st = domRef.current?.internal_scrollState
          if (!st) return 0
          return Math.max(0, st.contentHeight - st.viewportHeight)
        },
        getElement() {
          return domRef.current
        },
      }),
      [onScroll],
    )

    const style: Styles = {
      flexDirection: 'column',
      overflow: 'scroll',
      ...styleProps,
    }

    return React.createElement(
      'ink-scroll-box',
      {
        ref: domRef,
        style,
        scrollTop,
        stickyBottom,
      },
      React.createElement(
        'ink-box',
        {
          style: {
            flexDirection: 'column',
            flexShrink: 0,
            flexGrow: 0,
            width: '100%',
          },
        },
        children,
      ),
    )
  },
)

import type React from 'react'
import type { ScrollBoxHandle } from '../ink/components/scroll_box.js'
import { useKeybindings } from '../keybindings/use_keybinding.js'

export type ScrollKeybindingHandlerProps = {
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  viewportHeight: number
  isActive?: boolean
  onScrollChange?: (scrollTop: number, stickyBottom: boolean) => void
  onCopySelection?: () => void
}

/**
 * Binds semantic `Scroll` context keybindings (PageUp/PageDown, wheel,
 * Ctrl+Home/End, copy selection) to a `ScrollBoxHandle`.
 */
export function ScrollKeybindingHandler({
  scrollRef,
  viewportHeight,
  isActive = true,
  onScrollChange,
  onCopySelection,
}: ScrollKeybindingHandlerProps): React.ReactNode {
  const halfPage = Math.max(3, Math.floor(viewportHeight * 0.5))

  useKeybindings(
    {
      'scroll:pageUp': () => {
        scrollRef.current?.scrollBy(-halfPage)
        const top = scrollRef.current?.getScrollTop() ?? 0
        onScrollChange?.(top, false)
      },
      'scroll:pageDown': () => {
        scrollRef.current?.scrollBy(halfPage)
        const top = scrollRef.current?.getScrollTop() ?? 0
        const max = scrollRef.current?.getMaxScrollTop() ?? 0
        onScrollChange?.(top, top >= max)
      },
      'scroll:lineUp': () => {
        scrollRef.current?.scrollBy(-3)
        const top = scrollRef.current?.getScrollTop() ?? 0
        onScrollChange?.(top, false)
      },
      'scroll:lineDown': () => {
        scrollRef.current?.scrollBy(3)
        const top = scrollRef.current?.getScrollTop() ?? 0
        const max = scrollRef.current?.getMaxScrollTop() ?? 0
        onScrollChange?.(top, top >= max)
      },
      'scroll:top': () => {
        scrollRef.current?.scrollToTop()
        onScrollChange?.(0, false)
      },
      'scroll:bottom': () => {
        scrollRef.current?.scrollToBottom()
        const max = scrollRef.current?.getMaxScrollTop() ?? 0
        onScrollChange?.(max, true)
      },
      'selection:copy': () => {
        onCopySelection?.()
      },
    },
    { context: 'Scroll', isActive },
  )

  return null
}

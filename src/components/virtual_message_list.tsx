import React, { useEffect, useMemo } from 'react'
import { useVirtualScroll } from '../hooks/use_virtual_scroll.js'
import { Box } from '../ink/components/box.js'
import type { ScrollBoxHandle } from '../ink/components/scroll_box.js'
import type { DisplayListItem } from '../utilities/collapse_read_search.js'
import { parseDisplayTags } from '../utilities/display_tags.js'
import type { ToolResultLookup } from '../utilities/group_tool_uses.js'
import { useScrollChrome } from './fullscreen_layout.js'
import { MessageRow } from './message_row.js'

export type VirtualMessageListProps = {
  items: readonly DisplayListItem[]
  toolResults: ToolResultLookup
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  columns: number
  viewportHeight: number
  scrollTop: number
  stickyBottom: boolean
  streamingMessageUuid?: string | null
  verbose?: boolean
  showTimestamps?: boolean
  showModel?: boolean
  highlightedItemId?: string | null
  jumpToIndex?: number | null
}

function getStickyPromptPreview(item: DisplayListItem): string | null {
  if (item.kind !== 'message' || item.message.type !== 'user') return null
  if (item.message.isMeta) return null
  const content = item.message.message.content
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(b => b.type === 'text')
            .map(b => (b.type === 'text' ? b.text : ''))
            .join(' ')
        : ''
  const parsed = parseDisplayTags(raw)
  const text = (parsed.plainText || parsed.commandName || '').replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : null
}

/**
 * Fullscreen virtualized transcript renderer enforcing 80-line overscan,
 * 40-line scroll quantization, and a 300-item fiber mount cap.
 */
export function VirtualMessageList({
  items,
  toolResults,
  scrollRef,
  columns,
  viewportHeight,
  scrollTop,
  stickyBottom,
  streamingMessageUuid = null,
  verbose = false,
  showTimestamps = false,
  showModel = false,
  highlightedItemId = null,
  jumpToIndex = null,
}: VirtualMessageListProps): React.ReactNode {
  const itemKeys = useMemo(() => items.map(item => item.id), [items])
  const { setStickyPrompt } = useScrollChrome()

  const { range, topSpacer, bottomSpacer, measureRef, scrollToIndex } =
    useVirtualScroll(
      scrollRef,
      itemKeys,
      columns,
      viewportHeight,
      scrollTop,
      stickyBottom,
    )

  useEffect(() => {
    if (jumpToIndex !== null && jumpToIndex >= 0 && jumpToIndex < items.length) {
      scrollToIndex(jumpToIndex)
    }
  }, [jumpToIndex, items.length, scrollToIndex])

  // Update sticky prompt header when scrolled past an earlier user turn
  useEffect(() => {
    if (stickyBottom || scrollTop <= 2 || items.length === 0) {
      setStickyPrompt(null)
      return
    }
    const [startIdx] = range
    for (let i = Math.min(startIdx, items.length - 1); i >= 0; i--) {
      const preview = getStickyPromptPreview(items[i]!)
      if (preview) {
        setStickyPrompt({
          text: preview,
          scrollTo: () => scrollToIndex(i),
        })
        return
      }
    }
    setStickyPrompt(null)
  }, [stickyBottom, scrollTop, range, items, setStickyPrompt, scrollToIndex])

  const [startIndex, endIndex] = range
  const visibleSlice = items.slice(startIndex, endIndex)

  return (
    <Box flexDirection="column" width={columns}>
      {topSpacer > 0 ? <Box height={topSpacer} /> : null}
      {visibleSlice.map(item => {
        const isStreaming =
          streamingMessageUuid !== null &&
          item.kind === 'message' &&
          item.message.uuid === streamingMessageUuid
        return (
          <MessageRow
            key={item.id}
            item={item}
            toolResults={toolResults}
            width={columns}
            isStreaming={isStreaming}
            verbose={verbose}
            showTimestamps={showTimestamps}
            showModel={showModel}
            isHighlighted={highlightedItemId === item.id}
            measureRef={measureRef(item.id)}
          />
        )
      })}
      {bottomSpacer > 0 ? <Box height={bottomSpacer} /> : null}
    </Box>
  )
}

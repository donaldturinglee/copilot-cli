import React, { useMemo } from 'react'
import { Box } from '../ink/components/box.js'
import type { ScrollBoxHandle } from '../ink/components/scroll_box.js'
import type { Message } from '../types/message.js'
import { collapseBackgroundBashNotifications } from '../utilities/collapse_background_bash_notifications.js'
import { collapseHookSummaries } from '../utilities/collapse_hook_summaries.js'
import {
  collapseReadSearchGroups,
  type DisplayListItem,
} from '../utilities/collapse_read_search.js'
import { collapseTeammateShutdowns } from '../utilities/collapse_teammate_shutdowns.js'
import { buildToolResultLookup } from '../utilities/group_tool_uses.js'
import { MessageRow } from './message_row.js'
import { OffscreenFreeze } from './offscreen_freeze.js'
import { VirtualMessageList } from './virtual_message_list.js'

export type MessagesProps = {
  messages: readonly Message[]
  columns: number
  viewportHeight: number
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  scrollTop?: number
  stickyBottom?: boolean
  fullscreen?: boolean
  streamingMessageUuid?: string | null
  verbose?: boolean
  showTimestamps?: boolean
  showModel?: boolean
  highlightedItemId?: string | null
  jumpToIndex?: number | null
}

/**
 * Build the collapsed transcript display list:
 * 1. collapse silent stop-hook summaries
 * 2. collapse teammate shutdown notifications
 * 3. deduplicate adjacent background bash notifications
 * 4. group contiguous read/search-only tool turns
 */
export function buildDisplayList(
  messages: readonly Message[],
  verbose = false,
): DisplayListItem[] {
  const step1 = collapseHookSummaries(messages, verbose)
  const step2 = collapseTeammateShutdowns(step1, verbose)
  const step3 = collapseBackgroundBashNotifications(step2, verbose)
  return collapseReadSearchGroups(step3, verbose)
}

/**
 * Top-level transcript renderer:
 * - Fullscreen mode: `VirtualMessageList` with 80-line overscan / 300-item cap
 * - Main-screen mode: `OffscreenFreeze` around past historical rows to prevent
 *   full-screen redraw flicker during live streaming
 */
export function Messages({
  messages,
  columns,
  viewportHeight,
  scrollRef,
  scrollTop = 0,
  stickyBottom = true,
  fullscreen = true,
  streamingMessageUuid = null,
  verbose = false,
  showTimestamps = false,
  showModel = false,
  highlightedItemId = null,
  jumpToIndex = null,
}: MessagesProps): React.ReactNode {
  const toolResults = useMemo(() => buildToolResultLookup(messages), [messages])
  const displayItems = useMemo(
    () => buildDisplayList(messages, verbose),
    [messages, verbose],
  )

  if (fullscreen && scrollRef) {
    return (
      <VirtualMessageList
        items={displayItems}
        toolResults={toolResults}
        scrollRef={scrollRef}
        columns={columns}
        viewportHeight={viewportHeight}
        scrollTop={scrollTop}
        stickyBottom={stickyBottom}
        streamingMessageUuid={streamingMessageUuid}
        verbose={verbose}
        showTimestamps={showTimestamps}
        showModel={showModel}
        highlightedItemId={highlightedItemId}
        jumpToIndex={jumpToIndex}
      />
    )
  }

  // Main-screen mode: freeze historical items prior to the active tail
  const freezeBoundary = Math.max(0, displayItems.length - 2)
  return (
    <Box flexDirection="column" width={columns}>
      {displayItems.map((item, idx) => {
        const isStreaming =
          streamingMessageUuid !== null &&
          item.kind === 'message' &&
          item.message.uuid === streamingMessageUuid
        const isFrozen = idx < freezeBoundary && !isStreaming && highlightedItemId !== item.id
        return (
          <OffscreenFreeze key={item.id} frozen={isFrozen}>
            <MessageRow
              item={item}
              toolResults={toolResults}
              width={columns}
              isStreaming={isStreaming}
              verbose={verbose}
              showTimestamps={showTimestamps}
              showModel={showModel}
              isHighlighted={highlightedItemId === item.id}
            />
          </OffscreenFreeze>
        )
      })}
    </Box>
  )
}

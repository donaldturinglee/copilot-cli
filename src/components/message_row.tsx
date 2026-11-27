import React, { memo } from 'react'
import { Box } from '../ink/components/box.js'
import type { DOMElement } from '../ink/dom.js'
import type { DisplayListItem } from '../utilities/collapse_read_search.js'
import type { ToolResultLookup } from '../utilities/group_tool_uses.js'
import { MessageView } from './message.js'
import { CollapsedReadSearchView } from './messages/collapsed_read_search_view.js'

export type MessageRowProps = {
  item: DisplayListItem
  toolResults: ToolResultLookup
  width: number
  isStreaming: boolean
  verbose: boolean
  showTimestamps?: boolean
  showModel?: boolean
  isHighlighted?: boolean
  measureRef?: (el: DOMElement | null) => void
}

export const MessageRow = memo(function MessageRow({
  item,
  toolResults,
  width,
  isStreaming,
  verbose,
  showTimestamps = false,
  showModel = false,
  isHighlighted = false,
  measureRef,
}: MessageRowProps): React.ReactNode {
  return (
    <Box ref={measureRef} flexDirection="column" width={width}>
      {item.kind === 'collapsed_read_search' ? (
        <CollapsedReadSearchView group={item} />
      ) : (
        <MessageView
          message={item.message}
          toolResults={toolResults}
          width={width}
          isStreaming={isStreaming}
          verbose={verbose}
          showTimestamps={showTimestamps}
          showModel={showModel}
          isHighlighted={isHighlighted}
        />
      )}
    </Box>
  )
})

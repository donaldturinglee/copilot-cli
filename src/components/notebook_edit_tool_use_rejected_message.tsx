import React, { memo } from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'
import { FilePathLink } from './file_path_link.js'
import { MessageResponse } from './message_response.js'

export type NotebookEditToolUseRejectedMessageProps = {
  notebookPath: string
  cellId?: string
  reason?: string
}

export const NotebookEditToolUseRejectedMessage = memo(
  function NotebookEditToolUseRejectedMessage({
    notebookPath,
    cellId,
    reason,
  }: NotebookEditToolUseRejectedMessageProps): React.ReactNode {
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <ThemedText color="error">User rejected notebook edit to</ThemedText>
            <FilePathLink filePath={notebookPath} />
            {cellId ? <ThemedText dimColor>(cell {cellId})</ThemedText> : null}
          </Box>
          {reason ? <ThemedText dimColor>{reason}</ThemedText> : null}
        </Box>
      </MessageResponse>
    )
  },
)

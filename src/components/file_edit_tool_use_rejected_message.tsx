import React, { memo } from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'
import { FileEditToolDiff } from './file_edit_tool_diff.js'
import { FilePathLink } from './file_path_link.js'
import { MessageResponse } from './message_response.js'

export type FileEditToolUseRejectedMessageProps = {
  filePath: string
  oldString: string
  newString: string
  reason?: string
  width?: number
}

export const FileEditToolUseRejectedMessage = memo(
  function FileEditToolUseRejectedMessage({
    filePath,
    oldString,
    newString,
    reason,
    width = 76,
  }: FileEditToolUseRejectedMessageProps): React.ReactNode {
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <ThemedText color="error">User rejected edit to</ThemedText>
            <FilePathLink filePath={filePath} />
          </Box>
          {reason ? <ThemedText dimColor>{reason}</ThemedText> : null}
          {oldString || newString ? (
            <FileEditToolDiff
              filePath={filePath}
              oldString={oldString}
              newString={newString}
              width={width}
              dim={true}
            />
          ) : null}
        </Box>
      </MessageResponse>
    )
  },
)

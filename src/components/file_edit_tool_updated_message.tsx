import React, { memo } from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'
import { FileEditToolDiff } from './file_edit_tool_diff.js'
import { FilePathLink } from './file_path_link.js'
import { MessageResponse } from './message_response.js'

export type FileEditToolUpdatedMessageProps = {
  filePath: string
  oldString: string
  newString: string
  width?: number
}

export const FileEditToolUpdatedMessage = memo(
  function FileEditToolUpdatedMessage({
    filePath,
    oldString,
    newString,
    width = 76,
  }: FileEditToolUpdatedMessageProps): React.ReactNode {
    const added = newString.split('\n').length
    const removed = oldString.split('\n').length
    return (
      <MessageResponse>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <ThemedText color="success">Updated</ThemedText>
            <FilePathLink filePath={filePath} />
            <ThemedText dimColor>
              (+{added} / -{removed} lines)
            </ThemedText>
          </Box>
          <FileEditToolDiff
            filePath={filePath}
            oldString={oldString}
            newString={newString}
            width={width}
          />
        </Box>
      </MessageResponse>
    )
  },
)

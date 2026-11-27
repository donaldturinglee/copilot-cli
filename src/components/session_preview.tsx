import React from 'react'
import { Box } from '../ink/components/box.js'
import type { LogOption } from '../types/logs.js'
import { ThemedBox } from './design_system/themed_box.js'
import { ThemedText } from './design_system/themed_text.js'

export type SessionPreviewProps = {
  session: LogOption | null
}

export function SessionPreview({
  session,
}: SessionPreviewProps): React.ReactNode {
  if (!session) return null
  return (
    <ThemedBox
      borderStyle="single"
      borderColor="subtle"
      paddingX={1}
      flexDirection="column"
    >
      <ThemedText bold>{session.customTitle ?? session.summary ?? session.firstPrompt}</ThemedText>
      <Box flexDirection="row" gap={2}>
        <ThemedText dimColor>Messages: {session.messageCount}</ThemedText>
        <ThemedText dimColor>Modified: {session.modified.toLocaleString()}</ThemedText>
        {session.gitBranch ? (
          <ThemedText color="suggestion">branch: {session.gitBranch}</ThemedText>
        ) : null}
      </Box>
    </ThemedBox>
  )
}

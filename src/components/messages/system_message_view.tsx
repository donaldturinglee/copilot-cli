import React, { memo } from 'react'
import { Box } from '../../ink/components/box.js'
import type { SystemMessage } from '../../types/message.js'
import { CompactSummary } from '../compact_summary.js'
import { ThemedText } from '../design_system/themed_text.js'

export type SystemMessageViewProps = {
  message: SystemMessage
  width?: number
  verbose?: boolean
}

export const SystemMessageView = memo(function SystemMessageView({
  message,
  width = 80,
  verbose = false,
}: SystemMessageViewProps): React.ReactNode {
  if (message.isMeta && !verbose) return null

  switch (message.subtype) {
    case 'compact_boundary':
      return (
        <CompactSummary
          messagesSummarized={message.compactMetadata.messagesSummarized}
          preTokens={message.compactMetadata.preTokens}
          summaryText={message.content}
          width={Math.min(width, 72)}
        />
      )

    case 'microcompact_boundary':
      return (
        <Box marginLeft={2}>
          <ThemedText dimColor>
            Microcompacted · saved{' '}
            {message.microcompactMetadata.tokensSaved.toLocaleString()} tokens
          </ThemedText>
        </Box>
      )

    case 'api_error':
      return (
        <Box marginLeft={2}>
          <ThemedText color="error">
            API error ({message.retryAttempt}/{message.maxRetries}):{' '}
            {message.error.message}
          </ThemedText>
        </Box>
      )

    case 'stop_hook_summary':
      if (!verbose && !message.hasOutput && message.hookErrors.length === 0) {
        return null
      }
      return (
        <Box flexDirection="column" marginLeft={2}>
          <ThemedText color={message.hookErrors.length > 0 ? 'error' : 'subtle'}>
            Hooks ({message.hookCount}):{' '}
            {message.hookErrors.length > 0
              ? message.hookErrors.join('; ')
              : 'completed'}
          </ThemedText>
        </Box>
      )

    case 'turn_duration':
      if (!verbose) return null
      return (
        <Box marginLeft={2}>
          <ThemedText dimColor>
            Turn finished in {(message.durationMs / 1000).toFixed(1)}s
          </ThemedText>
        </Box>
      )

    case 'memory_saved':
      return (
        <Box marginLeft={2}>
          <ThemedText dimColor>
            {message.verb ?? 'Saved'} memory ({message.writtenPaths.join(', ')})
          </ThemedText>
        </Box>
      )

    case 'agents_killed':
      return (
        <Box marginLeft={2}>
          <ThemedText color="warning">Background agents stopped.</ThemedText>
        </Box>
      )

    case 'local_command':
    case 'informational': {
      const color =
        message.level === 'warning'
          ? 'warning'
          : message.level === 'suggestion'
            ? 'suggestion'
            : 'subtle'
      return (
        <Box marginLeft={2}>
          <ThemedText color={color}>{message.content}</ThemedText>
        </Box>
      )
    }

    case 'away_summary':
    case 'bridge_status':
    case 'scheduled_task_fire':
    case 'permission_retry':
    case 'file_snapshot':
    case 'thinking':
      return (
        <Box marginLeft={2}>
          <ThemedText dimColor>{message.content}</ThemedText>
        </Box>
      )

    case 'api_metrics':
      if (!verbose) return null
      return (
        <Box marginLeft={2}>
          <ThemedText dimColor>
            TTFT {message.ttftMs}ms · {message.otps.toFixed(1)} tok/s
          </ThemedText>
        </Box>
      )
  }
})

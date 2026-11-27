import React, { useState } from 'react'
import { Box } from '../ink/components/box.js'
import type { LogOption } from '../types/logs.js'
import { Select } from './custom_select/select.js'
import { ThemedText } from './design_system/themed_text.js'
import { SessionPreview } from './session_preview.js'

export type LogSelectorProps = {
  logs: readonly LogOption[]
  onSelect: (log: LogOption) => void
  onCancel: () => void
}

export function LogSelector({
  logs,
  onSelect,
  onCancel,
}: LogSelectorProps): React.ReactNode {
  const [focusedId, setFocusedId] = useState<string>(
    logs[0]?.sessionId ?? '0',
  )

  if (logs.length === 0) {
    return <ThemedText dimColor>No saved sessions found.</ThemedText>
  }

  const focused =
    logs.find((l, idx) => (l.sessionId ?? String(idx)) === focusedId) ??
    logs[0] ??
    null

  return (
    <Box flexDirection="column" gap={1}>
      <Select
        options={logs.slice(0, 15).map((log, idx) => ({
          label:
            log.customTitle ??
            log.summary ??
            log.firstPrompt.slice(0, 60) ??
            `Session ${idx + 1}`,
          value: log.sessionId ?? String(idx),
          description: `${log.messageCount} msgs`,
        }))}
        onFocus={setFocusedId}
        onChange={val => {
          const hit = logs.find(
            (l, idx) => (l.sessionId ?? String(idx)) === val,
          )
          if (hit) onSelect(hit)
        }}
        onCancel={onCancel}
      />
      <SessionPreview session={focused} />
    </Box>
  )
}

import React, { useState } from 'react'
import { Box } from '../ink/components/box.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'
import { TextInput } from './text_input.js'

export type FeedbackProps = {
  onSubmit: (note: string) => void
  onCancel: () => void
}

export function Feedback({
  onSubmit,
  onCancel,
}: FeedbackProps): React.ReactNode {
  const [note, setNote] = useState('')
  return (
    <Dialog
      title="Send Feedback (/feedback)"
      subtitle="Enter to submit · Esc to cancel"
      width={70}
      overlayId="feedback-dialog"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText dimColor>
          Describe any bug, friction point, or feature request:
        </ThemedText>
        <TextInput
          value={note}
          onChange={setNote}
          onSubmit={text => {
            if (text.trim()) onSubmit(text.trim())
            else onCancel()
          }}
          placeholder="Type feedback…"
        />
      </Box>
    </Dialog>
  )
}

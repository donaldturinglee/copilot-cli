import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/select.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type FeedbackRating = 'good' | 'bad' | 'dismiss'

export type FeedbackSurveyProps = {
  onSubmit: (rating: FeedbackRating) => void
}

export function FeedbackSurvey({
  onSubmit,
}: FeedbackSurveyProps): React.ReactNode {
  return (
    <Dialog
      title="How is Copilot CLI doing?"
      subtitle="Optional quick rating"
      overlayId="feedback-survey"
      onCancel={() => onSubmit('dismiss')}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText dimColor>Your feedback helps improve Copilot CLI.</ThemedText>
        <Select
          options={[
            { label: 'Good (helpful & accurate)', value: 'good' },
            { label: 'Needs improvement', value: 'bad' },
            { label: 'Dismiss', value: 'dismiss' },
          ]}
          onChange={val => onSubmit(val as FeedbackRating)}
        />
      </Box>
    </Dialog>
  )
}

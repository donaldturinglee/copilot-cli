import React from 'react'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import type { PermissionDialogProps } from './types.js'

type QuestionItem = {
  question: string
  options?: Array<{ label: string; description?: string }>
}

export function AskUserQuestionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const questions = Array.isArray(request.input.questions)
    ? (request.input.questions as QuestionItem[])
    : []
  const first = questions[0]
  const options = first?.options?.length
    ? first.options.map(o => ({
        label: o.label,
        value: o.label,
        description: o.description,
      }))
    : [
        { label: 'Yes', value: 'Yes' },
        { label: 'No', value: 'No' },
      ]

  return (
    <Dialog
      title="Copilot has a question"
      borderColor="suggestion"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() =>
        onResolve({ behavior: 'deny', message: 'User dismissed question.' })
      }
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText bold>{first?.question ?? 'Please choose an option:'}</ThemedText>
        <Select
          options={options}
          onChange={answer => {
            const answers: Record<string, string> = {}
            if (first?.question) answers[first.question] = answer
            onResolve({
              behavior: 'allow',
              updatedInput: {
                ...request.input,
                answers,
              },
            })
          }}
        />
      </Box>
    </Dialog>
  )
}

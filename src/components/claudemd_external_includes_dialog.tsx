import React from 'react'
import { Box } from '../ink/components/box.js'
import { Select } from './custom_select/index.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type ClaudeMdExternalIncludesDialogProps = {
  paths: readonly string[]
  onDecision: (approved: boolean) => void
}

export function ClaudeMdExternalIncludesDialog({
  paths,
  onDecision,
}: ClaudeMdExternalIncludesDialogProps): React.ReactNode {
  return (
    <Dialog
      title="External CLAUDE.md Includes Detected"
      borderColor="warning"
      onCancel={() => onDecision(false)}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          This project references instruction files outside the repository:
        </ThemedText>
        {paths.map((p, i) => (
          <ThemedText key={i} dimColor>
            · {p}
          </ThemedText>
        ))}
        <Select<'allow' | 'skip'>
          options={[
            { label: 'Allow external includes', value: 'allow' },
            { label: 'Skip external includes', value: 'skip' },
          ]}
          onChange={v => onDecision(v === 'allow')}
          onCancel={() => onDecision(false)}
        />
      </Box>
    </Dialog>
  )
}

import React from 'react'
import { Box } from '../ink/components/box.js'
import { saveCurrentProjectConfig } from '../utilities/config.js'
import { Select } from './custom_select/index.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'

export type TrustDialogProps = {
  cwd: string
  onTrust: () => void
  onReject: () => void
  persist?: boolean
}

/**
 * Workspace trust security gate displayed before enabling project hooks,
 * project MCP servers, or project settings.
 */
export function TrustDialog({
  cwd,
  onTrust,
  onReject,
  persist = true,
}: TrustDialogProps): React.ReactNode {
  const handleSelect = (choice: 'yes' | 'no'): void => {
    if (choice === 'yes') {
      if (persist) {
        saveCurrentProjectConfig(prev => ({
          ...prev,
          hasTrustDialogAccepted: true,
        }))
      }
      onTrust()
    } else {
      onReject()
    }
  }

  return (
    <Dialog
      title="Do you trust the files in this folder?"
      subtitle={cwd}
      borderColor="warning"
      onCancel={onReject}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>
          Copilot CLI may read, edit, and execute files or configured hooks in
          this workspace. Only proceed if you trust the contents of this
          directory.
        </ThemedText>
        <Select<'yes' | 'no'>
          options={[
            {
              label: 'Yes, proceed and trust this folder',
              value: 'yes',
            },
            {
              label: 'No, exit',
              value: 'no',
            },
          ]}
          onChange={handleSelect}
          onCancel={onReject}
        />
      </Box>
    </Dialog>
  )
}

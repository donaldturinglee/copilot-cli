import React from 'react'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import { buildAlwaysAllowUpdate } from './permission_persistence.js'
import type { PermissionDialogProps } from './types.js'

export function FallbackPermissionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const preview = JSON.stringify(request.input, null, 2).slice(0, 400)

  return (
    <Dialog
      title={`Allow tool: ${request.toolName}`}
      subtitle={request.askDecision.message}
      borderColor="permission"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() =>
        onResolve({
          behavior: 'deny',
          message: `User rejected ${request.toolName}.`,
        })
      }
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText dimColor>{preview}</ThemedText>
        <Select
          options={[
            { label: 'Yes, allow once', value: 'once' },
            {
              label: `Yes, always allow ${request.toolName}`,
              value: 'always_local',
              description: 'Save to .copilot/settings.local.json',
            },
            { label: 'No, reject', value: 'deny' },
          ]}
          onChange={choice => {
            if (choice === 'once') onResolve({ behavior: 'allow' })
            else if (choice === 'always_local') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: buildAlwaysAllowUpdate(
                  request.toolName,
                  request.input,
                  'localSettings',
                  request.askDecision.suggestions,
                ),
                persistToDisk: true,
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: `User rejected ${request.toolName}.`,
              })
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

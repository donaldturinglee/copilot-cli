import React from 'react'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import { buildAlwaysAllowUpdate } from './permission_persistence.js'
import type { PermissionDialogProps } from './types.js'

export function NotebookEditPermissionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const notebookPath =
    typeof request.input.notebook_path === 'string'
      ? request.input.notebook_path
      : '(unknown notebook)'
  const editMode =
    typeof request.input.edit_mode === 'string'
      ? request.input.edit_mode
      : 'replace'

  return (
    <Dialog
      title={`NotebookEdit: ${notebookPath}`}
      subtitle={`Mode: ${editMode}`}
      borderColor="permission"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() =>
        onResolve({
          behavior: 'deny',
          message: `User rejected notebook edit to ${notebookPath}.`,
        })
      }
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText dimColor>
          Allow modifying Jupyter notebook cell in {notebookPath}?
        </ThemedText>
        <Select
          options={[
            { label: 'Yes, allow once', value: 'once' },
            {
              label: 'Yes, always allow NotebookEdit',
              value: 'always_local',
            },
            { label: 'No, reject', value: 'deny' },
          ]}
          onChange={choice => {
            if (choice === 'once') onResolve({ behavior: 'allow' })
            else if (choice === 'always_local') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: buildAlwaysAllowUpdate(
                  'NotebookEdit',
                  request.input,
                  'localSettings',
                  request.askDecision.suggestions,
                ),
                persistToDisk: true,
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: `User rejected notebook edit to ${notebookPath}.`,
              })
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

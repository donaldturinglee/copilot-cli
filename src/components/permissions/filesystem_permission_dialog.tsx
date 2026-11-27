import React from 'react'
import { dirname } from 'path'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import type { PermissionDialogProps } from './types.js'

export function FilesystemPermissionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const targetPath =
    typeof request.input.file_path === 'string'
      ? request.input.file_path
      : typeof request.input.path === 'string'
        ? request.input.path
        : '(external path)'
  const dir = dirname(targetPath)

  return (
    <Dialog
      title={`Filesystem access (${request.toolName})`}
      subtitle={request.askDecision.message}
      borderColor="warning"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() =>
        onResolve({
          behavior: 'deny',
          message: `User denied filesystem access to ${targetPath}.`,
        })
      }
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText>Path: {targetPath}</ThemedText>
        <Select
          options={[
            { label: 'Yes, allow once', value: 'once' },
            {
              label: `Yes, allow directory ${dir} for this session`,
              value: 'add_dir',
            },
            { label: 'No, deny access', value: 'deny' },
          ]}
          onChange={choice => {
            if (choice === 'once') onResolve({ behavior: 'allow' })
            else if (choice === 'add_dir') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: [
                  {
                    type: 'addDirectories',
                    directories: [dir],
                    destination: 'session',
                  },
                ],
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: `User denied filesystem access to ${targetPath}.`,
              })
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

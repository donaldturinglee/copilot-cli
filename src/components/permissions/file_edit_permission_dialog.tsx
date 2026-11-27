import React from 'react'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import { FileEditToolDiff } from '../file_edit_tool_diff.js'
import { buildAlwaysAllowUpdate } from './permission_persistence.js'
import type { PermissionDialogProps } from './types.js'

export function FileEditPermissionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const filePath =
    typeof request.input.file_path === 'string'
      ? request.input.file_path
      : '(unknown file)'
  const oldString =
    typeof request.input.old_string === 'string' ? request.input.old_string : ''
  const newString =
    typeof request.input.new_string === 'string' ? request.input.new_string : ''

  return (
    <Dialog
      title={`Edit file: ${filePath}`}
      subtitle={request.askDecision.message}
      borderColor="permission"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() =>
        onResolve({ behavior: 'deny', message: `User rejected edit to ${filePath}.` })
      }
    >
      <Box flexDirection="column" gap={1}>
        {oldString || newString ? (
          <FileEditToolDiff
            filePath={filePath}
            oldString={oldString}
            newString={newString}
            width={width - 4}
          />
        ) : (
          <ThemedText dimColor>(No diff preview available)</ThemedText>
        )}
        <Select
          options={[
            { label: 'Yes, apply this edit', value: 'once' },
            {
              label: 'Yes, allow all edits in this session (acceptEdits)',
              value: 'session_edits',
            },
            {
              label: 'Yes, always allow Edit tool',
              value: 'always_local',
              description: 'Save to .copilot/settings.local.json',
            },
            { label: 'No, reject edit', value: 'deny' },
          ]}
          onChange={choice => {
            if (choice === 'once') {
              onResolve({ behavior: 'allow' })
            } else if (choice === 'session_edits') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: [
                  {
                    type: 'setMode',
                    mode: 'acceptEdits',
                    destination: 'session',
                  },
                ],
              })
            } else if (choice === 'always_local') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: buildAlwaysAllowUpdate(
                  'Edit',
                  request.input,
                  'localSettings',
                  request.askDecision.suggestions,
                ),
                persistToDisk: true,
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: `User rejected edit to ${filePath}.`,
              })
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

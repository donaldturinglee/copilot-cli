import React from 'react'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedBox } from '../design_system/themed_box.js'
import { ThemedText } from '../design_system/themed_text.js'
import { buildAlwaysAllowUpdate } from './permission_persistence.js'
import type { PermissionDialogProps } from './types.js'

export function FileWritePermissionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const filePath =
    typeof request.input.file_path === 'string'
      ? request.input.file_path
      : '(unknown file)'
  const content =
    typeof request.input.content === 'string' ? request.input.content : ''
  const previewLines = content.split('\n').slice(0, 8)

  return (
    <Dialog
      title={`Write file: ${filePath}`}
      subtitle={request.askDecision.message}
      borderColor="permission"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() =>
        onResolve({ behavior: 'deny', message: `User rejected write to ${filePath}.` })
      }
    >
      <Box flexDirection="column" gap={1}>
        <ThemedBox borderStyle="single" borderColor="subtle" paddingX={1} flexDirection="column">
          {previewLines.map((line, i) => (
            <ThemedText key={i} dimColor wrap="truncate-end">
              {line}
            </ThemedText>
          ))}
          {content.split('\n').length > 8 ? (
            <ThemedText dimColor>
              … ({content.split('\n').length} total lines)
            </ThemedText>
          ) : null}
        </ThemedBox>
        <Select
          options={[
            { label: 'Yes, write file', value: 'once' },
            {
              label: 'Yes, always allow Write tool',
              value: 'always_local',
              description: 'Save to .copilot/settings.local.json',
            },
            { label: 'No, reject write', value: 'deny' },
          ]}
          onChange={choice => {
            if (choice === 'once') {
              onResolve({ behavior: 'allow' })
            } else if (choice === 'always_local') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: buildAlwaysAllowUpdate(
                  'Write',
                  request.input,
                  'localSettings',
                  request.askDecision.suggestions,
                ),
                persistToDisk: true,
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: `User rejected write to ${filePath}.`,
              })
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

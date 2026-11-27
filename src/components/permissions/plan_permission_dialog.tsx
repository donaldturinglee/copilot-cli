import React from 'react'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedBox } from '../design_system/themed_box.js'
import { ThemedText } from '../design_system/themed_text.js'
import type { PermissionDialogProps } from './types.js'

export function PlanPermissionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const plan =
    typeof request.input.plan === 'string'
      ? request.input.plan
      : 'Ready to exit plan mode and start implementing.'

  return (
    <Dialog
      title="Approve Implementation Plan"
      subtitle="Choose how to proceed out of plan mode"
      borderColor="planMode"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() =>
        onResolve({ behavior: 'deny', message: 'User chose to keep planning.' })
      }
    >
      <Box flexDirection="column" gap={1}>
        <ThemedBox borderStyle="single" borderColor="planMode" paddingX={1}>
          <ThemedText>{plan.slice(0, 600)}</ThemedText>
        </ThemedBox>
        <Select
          options={[
            {
              label: 'Yes, approve plan and accept edits automatically',
              value: 'accept_edits',
            },
            {
              label: 'Yes, approve plan (manual edit approvals)',
              value: 'default_mode',
            },
            { label: 'No, stay in plan mode and revise', value: 'deny' },
          ]}
          onChange={choice => {
            if (choice === 'accept_edits') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: [
                  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
                ],
              })
            } else if (choice === 'default_mode') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: [
                  { type: 'setMode', mode: 'default', destination: 'session' },
                ],
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: 'User rejected plan; keep revising.',
              })
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

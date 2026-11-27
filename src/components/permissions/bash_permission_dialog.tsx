import React from 'react'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedBox } from '../design_system/themed_box.js'
import { ThemedText } from '../design_system/themed_text.js'
import {
  buildAlwaysAllowRuleForTool,
  buildAlwaysAllowUpdate,
} from './permission_persistence.js'
import { permissionRuleValueToString } from '../../utilities/permissions/permission_rule_parser.js'
import type { PermissionDialogProps } from './types.js'

export function BashPermissionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const command =
    typeof request.input.command === 'string' ? request.input.command : ''
  const description =
    typeof request.input.description === 'string'
      ? request.input.description
      : undefined
  const ruleLabel = permissionRuleValueToString(
    buildAlwaysAllowRuleForTool('Bash', request.input),
  )

  return (
    <Dialog
      title="Bash command approval"
      subtitle={description ?? request.askDecision.message}
      borderColor="permission"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() => onResolve({ behavior: 'deny', message: 'User rejected Bash command.' })}
    >
      <Box flexDirection="column" gap={1}>
        <ThemedBox
          borderStyle="single"
          borderColor="bashBorder"
          paddingX={1}
          flexDirection="column"
        >
          <ThemedText bold>{command || '(empty command)'}</ThemedText>
        </ThemedBox>
        <Select
          options={[
            { label: 'Yes, allow once', value: 'once' },
            {
              label: `Yes, always allow ${ruleLabel}`,
              value: 'always_local',
              description: 'Save to .copilot/settings.local.json',
            },
            {
              label: 'Yes, allow for this session',
              value: 'session',
            },
            { label: 'No, reject command', value: 'deny' },
          ]}
          onChange={choice => {
            if (choice === 'once') {
              onResolve({ behavior: 'allow' })
            } else if (choice === 'always_local') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: buildAlwaysAllowUpdate(
                  'Bash',
                  request.input,
                  'localSettings',
                  request.askDecision.suggestions,
                ),
                persistToDisk: true,
              })
            } else if (choice === 'session') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: buildAlwaysAllowUpdate(
                  'Bash',
                  request.input,
                  'session',
                  request.askDecision.suggestions,
                ),
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: 'User rejected Bash command.',
              })
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

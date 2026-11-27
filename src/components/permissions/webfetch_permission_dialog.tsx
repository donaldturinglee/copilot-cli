import React from 'react'
import { Box } from '../../ink/components/box.js'
import { permissionRuleValueToString } from '../../utilities/permissions/permission_rule_parser.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import {
  buildAlwaysAllowRuleForTool,
  buildAlwaysAllowUpdate,
} from './permission_persistence.js'
import type { PermissionDialogProps } from './types.js'

export function WebFetchPermissionDialog({
  request,
  width = 76,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const url = typeof request.input.url === 'string' ? request.input.url : ''
  const ruleLabel = permissionRuleValueToString(
    buildAlwaysAllowRuleForTool('WebFetch', request.input),
  )

  return (
    <Dialog
      title="WebFetch approval"
      subtitle={request.askDecision.message}
      borderColor="permission"
      width={width}
      overlayId={`perm-${request.id}`}
      onCancel={() =>
        onResolve({ behavior: 'deny', message: 'User rejected WebFetch.' })
      }
    >
      <Box flexDirection="column" gap={1}>
        <ThemedText color="suggestion">{url}</ThemedText>
        <Select
          options={[
            { label: 'Yes, fetch once', value: 'once' },
            {
              label: `Yes, always allow ${ruleLabel}`,
              value: 'always_local',
            },
            { label: 'No, reject fetch', value: 'deny' },
          ]}
          onChange={choice => {
            if (choice === 'once') onResolve({ behavior: 'allow' })
            else if (choice === 'always_local') {
              onResolve({
                behavior: 'allow',
                updatedPermissions: buildAlwaysAllowUpdate(
                  'WebFetch',
                  request.input,
                  'localSettings',
                  request.askDecision.suggestions,
                ),
                persistToDisk: true,
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: 'User rejected WebFetch.',
              })
            }
          }}
        />
      </Box>
    </Dialog>
  )
}

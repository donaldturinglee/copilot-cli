/**
 * Interactive permission approval dialog for `SkillTool` (`Skill(name)` /
 * `Skill(name:*)`).
 */

import React from 'react'
import { SKILL_TOOL_NAME } from '../../constants/tools.js'
import { Box } from '../../ink/components/box.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import type { PermissionDialogProps } from './types.js'

/**
 * Renders the interactive approval prompt before executing a privileged skill.
 */
export function SkillPermissionDialog({
  request,
  width,
  onResolve,
}: PermissionDialogProps): React.ReactNode {
  const rawSkill =
    typeof request.input.skill === 'string'
      ? request.input.skill.trim().replace(/^\/+/, '')
      : 'unknown'
  const rawArgs =
    typeof request.input.args === 'string' ? request.input.args.trim() : ''
  const description = request.askDecision.metadata?.command?.description

  const options = [
    { label: 'Yes', value: 'yes' },
    {
      label: `Yes, and don't ask again for Skill(${rawSkill})`,
      value: 'yes-exact',
    },
    ...(rawArgs
      ? [
          {
            label: `Yes, and don't ask again for Skill(${rawSkill}:*)`,
            value: 'yes-prefix',
          },
        ]
      : []),
    { label: 'No', value: 'no' },
  ]

  return (
    <Dialog
      title={`Use skill "${rawSkill}"?`}
      borderColor="permission"
      width={width}
      onCancel={() =>
        onResolve({
          behavior: 'deny',
          message: 'User rejected skill execution',
        })
      }
    >
      <Box flexDirection="column" gap={1}>
        {description ? <ThemedText dimColor>{description}</ThemedText> : null}
        {rawArgs ? <ThemedText>Arguments: {rawArgs}</ThemedText> : null}
        <Select
          options={options}
          onChange={choice => {
            if (choice === 'yes') {
              onResolve({ behavior: 'allow' })
            } else if (choice === 'yes-exact') {
              onResolve({
                behavior: 'allow',
                persistToDisk: true,
                updatedPermissions: [
                  {
                    type: 'addRules',
                    destination: 'localSettings',
                    behavior: 'allow',
                    rules: [
                      { toolName: SKILL_TOOL_NAME, ruleContent: rawSkill },
                    ],
                  },
                ],
              })
            } else if (choice === 'yes-prefix') {
              onResolve({
                behavior: 'allow',
                persistToDisk: true,
                updatedPermissions: [
                  {
                    type: 'addRules',
                    destination: 'localSettings',
                    behavior: 'allow',
                    rules: [
                      {
                        toolName: SKILL_TOOL_NAME,
                        ruleContent: `${rawSkill}:*`,
                      },
                    ],
                  },
                ],
              })
            } else {
              onResolve({
                behavior: 'deny',
                message: 'User rejected skill execution',
              })
            }
          }}
          onCancel={() =>
            onResolve({
              behavior: 'deny',
              message: 'User rejected skill execution',
            })
          }
        />
      </Box>
    </Dialog>
  )
}

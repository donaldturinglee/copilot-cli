/**
 * Permission-mode validation for `BashTool` (primarily `plan` mode guard).
 */

import type {
  PermissionResult,
  ToolPermissionContext,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import { isReadOnlyBashCommandAsync } from './read_only_validation.js'

export async function checkPermissionMode<Input extends { command: string }>(
  input: Input,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): Promise<PermissionResult<Input>> {
  if (permissionContext.mode === 'plan') {
    const readOnly = await isReadOnlyBashCommandAsync(input.command)
    if (readOnly) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'mode', mode: 'plan' },
      }
    }
    return {
      behavior: 'deny',
      message: `Plan mode only permits read-only Bash commands; blocked: ${input.command}`,
      decisionReason: { type: 'mode', mode: 'plan' },
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Mode check passed through',
  }
}

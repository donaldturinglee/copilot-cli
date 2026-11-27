/**
 * Mode validation (`plan` mode guard) for `PowerShellTool`.
 */

import type {
  PermissionResult,
  ToolPermissionContext,
} from '../../types/permissions.js'
import type { DeepImmutable } from '../../types/utils.js'
import type { ParsedPowerShellCommand } from '../../utilities/powershell/parser.js'
import { isReadOnlyParsedPowerShellCommand } from './read_only_validation.js'

export function checkPowerShellPermissionMode<Input extends { command: string }>(
  input: Input,
  parsed: ParsedPowerShellCommand,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): PermissionResult<Input> {
  if (permissionContext.mode === 'plan') {
    if (isReadOnlyParsedPowerShellCommand(parsed)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'mode', mode: 'plan' },
      }
    }
    return {
      behavior: 'deny',
      message: `Plan mode only permits read-only PowerShell commands; blocked: ${input.command}`,
      decisionReason: { type: 'mode', mode: 'plan' },
    }
  }

  return {
    behavior: 'passthrough',
    message: 'Mode check passed through',
  }
}

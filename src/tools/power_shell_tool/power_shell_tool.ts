/**
 * `PowerShellTool` (`PowerShell`):
 * Cross-platform PowerShell execution tool (`pwsh` / Windows PowerShell 5.1)
 * with UTF-16LE `-EncodedCommand` invocation, CWD persistence, timeout
 * process-tree termination, `PowerShellProgress` streaming, and background
 * execution support.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolCallProgress, type ToolUseContext } from '../../tool.js'
import { getEmptyToolPermissionContext } from '../../types/permissions.js'
import type { PowerShellProgress } from '../../types/tools.js'
import { getCwd } from '../../utilities/cwd.js'
import { ShellError } from '../../utilities/errors.js'
import {
  formatPermissionRuleValue,
  getRulesForTool,
  matchWildcardPattern,
} from '../../utilities/permissions/rule_matching.js'
import { exec } from '../../utilities/shell.js'
import { BASH_MAX_OUTPUT_DEFAULT } from '../../utilities/shell/output_limits.js'
import { findPowerShell } from '../../utilities/shell/powershell_detection.js'
import {
  isBackgroundTasksDisabled,
  isPowerShellToolEnabled,
} from '../../utilities/shell/shell_tool_utils.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utilities/shell_config.js'
import { truncateShellOutput } from '../bash_tool/utils.js'
import { trackGitOperations } from '../shared/git_operation_tracking.js'
import { interpretPowerShellResult } from './command_semantics.js'
import {
  POWERSHELL_TOOL_DESCRIPTION,
  POWERSHELL_TOOL_PROMPT,
} from './prompt.js'
import { POWERSHELL_TOOL_NAME } from './tool_name.js'

const PowerShellInputSchema = z.object({
  command: z.string().describe('The PowerShell command to execute'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional timeout in milliseconds (max 600000)'),
  description: z
    .string()
    .optional()
    .describe('Short description of what this command does'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Set to true to run this command in the background'),
})

export type PowerShellInput = z.infer<typeof PowerShellInputSchema>

export interface PowerShellOutput {
  stdout: string
  stderr: string
  interrupted: boolean
  returnCodeInterpretation?: string
  backgroundTaskId?: string
  backgroundTaskOutputPath?: string
}

export const PowerShellTool = buildTool<
  PowerShellInput,
  PowerShellOutput,
  PowerShellProgress
>({
  name: POWERSHELL_TOOL_NAME,
  searchHint: 'run PowerShell commands on Windows or with pwsh',
  maxResultSizeChars: BASH_MAX_OUTPUT_DEFAULT,
  inputSchema: PowerShellInputSchema,

  isEnabled() {
    return isPowerShellToolEnabled() && findPowerShell() !== null
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  interruptBehavior: () => 'cancel',

  toAutoClassifierInput(input) {
    return input.command
  },

  userFacingName(input) {
    return input?.command
      ? `PowerShell(${input.command.slice(0, 60)})`
      : POWERSHELL_TOOL_NAME
  },

  async description() {
    return POWERSHELL_TOOL_DESCRIPTION
  },

  async prompt() {
    return POWERSHELL_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()

    const denyRules = getRulesForTool(
      permCtx,
      { name: POWERSHELL_TOOL_NAME },
      'deny',
    )
    for (const rule of denyRules) {
      const pat = rule.ruleValue.ruleContent
      if (pat === undefined || matchWildcardPattern(input.command, pat)) {
        return {
          behavior: 'deny',
          message: `PowerShell command denied by rule ${formatPermissionRuleValue(rule.ruleValue)}.`,
          decisionReason: { type: 'rule', rule },
        }
      }
    }

    if (permCtx.mode === 'bypassPermissions') {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'mode', mode: 'bypassPermissions' },
      }
    }

    const allowRules = getRulesForTool(
      permCtx,
      { name: POWERSHELL_TOOL_NAME },
      'allow',
    )
    for (const rule of allowRules) {
      const pat = rule.ruleValue.ruleContent
      if (pat === undefined || matchWildcardPattern(input.command, pat)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: { type: 'rule', rule },
        }
      }
    }

    return {
      behavior: 'ask',
      message: `Allow running PowerShell command: ${input.command}`,
      updatedInput: input,
      decisionReason: { type: 'mode', mode: permCtx.mode },
    }
  },

  async validateInput(input) {
    if (!input.command.trim()) {
      return {
        result: false,
        message: 'PowerShell command must not be empty.',
        errorCode: 1,
      }
    }
    const maxTimeout = getMaxBashTimeoutMs()
    if (input.timeout !== undefined && input.timeout > maxTimeout) {
      return {
        result: false,
        message: `Timeout ${input.timeout}ms exceeds maximum allowed (${maxTimeout}ms).`,
        errorCode: 2,
      }
    }
    if (input.run_in_background && isBackgroundTasksDisabled()) {
      return {
        result: false,
        message:
          'Background shell tasks are disabled by COPILOT_CLI_DISABLE_BACKGROUND_TASKS.',
        errorCode: 3,
      }
    }
    return { result: true }
  },

  async call(
    input,
    context: ToolUseContext,
    _canUseTool,
    _parentMessage,
    onProgress?: ToolCallProgress<PowerShellProgress>,
  ) {
    const timeoutMs = Math.min(
      input.timeout ?? getDefaultBashTimeoutMs(),
      getMaxBashTimeoutMs(),
    )
    const runInBackground = Boolean(input.run_in_background)

    const shellCmd = await exec(
      input.command,
      context.abortController.signal,
      'powershell',
      {
        timeoutMs,
        cwd: getCwd(),
        runInBackground,
        onProgress: onProgress
          ? progress => {
              onProgress({
                toolUseId: progress.taskId ?? 'powershell',
                data: {
                  type: 'powershell_progress',
                  output: progress.output,
                  fullOutput: progress.fullOutput,
                  elapsedTimeSeconds: progress.elapsedTimeSeconds,
                  totalLines: progress.totalLines,
                  totalBytes: progress.totalBytes,
                  taskId: progress.taskId,
                  timeoutMs,
                },
              })
            }
          : undefined,
        onBackgroundExit: result => {
          context.setAppState?.(prev => {
            const existing = prev.tasks[shellCmd.taskId]
            if (!existing) return prev
            return {
              ...prev,
              tasks: {
                ...prev.tasks,
                [shellCmd.taskId]: {
                  ...existing,
                  status: result.code === 0 ? 'completed' : 'failed',
                  exitCode: result.code,
                },
              },
            }
          })
        },
      },
    )

    if (runInBackground) {
      context.setAppState?.(prev => ({
        ...prev,
        tasks: {
          ...prev.tasks,
          [shellCmd.taskId]: {
            id: shellCmd.taskId,
            type: 'local_bash',
            status: 'running',
            description: input.description ?? input.command.slice(0, 80),
            outputPath: shellCmd.outputPath,
          },
        },
      }))
    }

    const result = await shellCmd.result
    if (!result.backgroundTaskId) {
      shellCmd.cleanup()
    }

    trackGitOperations(input.command, result.code, result.stdout)

    const semantics = interpretPowerShellResult(result.code, result.stderr)
    if (result.code !== 0 && semantics.isError && !result.backgroundTaskId) {
      throw new ShellError(
        result.stdout,
        result.stderr,
        result.code,
        result.interrupted,
      )
    }

    const truncatedOut = truncateShellOutput(result.stdout)
    const truncatedErr = truncateShellOutput(result.stderr)

    return {
      data: {
        stdout: truncatedOut.content,
        stderr: truncatedErr.content,
        interrupted: result.interrupted,
        ...(result.backgroundTaskId
          ? { backgroundTaskId: result.backgroundTaskId }
          : {}),
        ...(result.backgroundTaskOutputPath
          ? { backgroundTaskOutputPath: result.backgroundTaskOutputPath }
          : {}),
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    if (output.backgroundTaskId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `PowerShell command running in background with ID: ${output.backgroundTaskId}.${output.backgroundTaskOutputPath ? ` Output file: ${output.backgroundTaskOutputPath}` : ''}`,
      }
    }

    const sections: string[] = []
    if (output.stdout) sections.push(output.stdout.trimEnd())
    if (output.stderr) sections.push(output.stderr.trimEnd())
    if (output.interrupted) {
      sections.push('<error>Command was interrupted.</error>')
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: sections.length > 0 ? sections.join('\n') : '(no output)',
    }
  },
})

/**
 * `BashTool` (`Bash`):
 * Cross-platform bash execution tool built on the per-command spawn engine
 * (`src/utilities/shell.ts`):
 * - Persistent working directory across commands
 * - Configurable timeout (default 120s, max 600s) with `tree-kill` cleanup
 * - Live `BashProgress` streaming
 * - Optional `run_in_background` task registration
 * - Semantic exit code interpretation & git operation telemetry
 * - Clean Phase 4 extension hooks for AST security & OS sandboxing
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { z } from 'zod/v4'
import { buildTool, type ToolCallProgress, type ToolUseContext } from '../../tool.js'
import type { BashProgress } from '../../types/tools.js'
import { getCwd } from '../../utilities/cwd.js'
import { ShellError } from '../../utilities/errors.js'
import { SandboxManager } from '../../utilities/sandbox/sandbox_adapter.js'
import { exec } from '../../utilities/shell.js'
import { BASH_MAX_OUTPUT_DEFAULT } from '../../utilities/shell/output_limits.js'
import { isSimpleReadOnlyCommand } from '../../utilities/shell/read_only_command_validation.js'
import { isBackgroundTasksDisabled } from '../../utilities/shell/shell_tool_utils.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utilities/shell_config.js'
import { trackGitOperations } from '../shared/git_operation_tracking.js'
import { bashToolHasPermission } from './bash_permissions.js'
import { interpretCommandResult } from './command_semantics.js'
import { BASH_TOOL_DESCRIPTION, BASH_TOOL_PROMPT } from './prompt.js'
import { shouldUseSandbox } from './should_use_sandbox.js'
import { BASH_TOOL_NAME } from './tool_name.js'
import { extractImageDataUri, truncateShellOutput } from './utils.js'

const BashInputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
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
  dangerouslyDisableSandbox: z
    .boolean()
    .optional()
    .describe('Override sandbox mode if permitted by policy'),
})

export type BashInput = z.infer<typeof BashInputSchema>

export interface BashOutput {
  stdout: string
  stderr: string
  interrupted: boolean
  isImage: boolean
  returnCodeInterpretation?: string
  backgroundTaskId?: string
  backgroundTaskOutputPath?: string
  noOutputExpected?: boolean
}

export const BashTool = buildTool<BashInput, BashOutput, BashProgress>({
  name: BASH_TOOL_NAME,
  searchHint: 'run shell commands, tests, git operations, and build scripts',
  maxResultSizeChars: BASH_MAX_OUTPUT_DEFAULT,
  inputSchema: BashInputSchema,

  isReadOnly(input) {
    return isSimpleReadOnlyCommand(input.command)
  },

  isConcurrencySafe(input) {
    return isSimpleReadOnlyCommand(input.command)
  },

  isDestructive: () => false,
  interruptBehavior: () => 'cancel',

  toAutoClassifierInput(input) {
    return input.command
  },

  userFacingName(input) {
    return input?.command
      ? `Bash(${input.command.slice(0, 60)})`
      : BASH_TOOL_NAME
  },

  async description() {
    return BASH_TOOL_DESCRIPTION
  },

  async prompt() {
    return BASH_TOOL_PROMPT
  },

  async checkPermissions(input, context) {
    return bashToolHasPermission(input, context)
  },

  async validateInput(input) {
    if (!input.command.trim()) {
      return {
        result: false,
        message: 'Bash command must not be empty.',
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
    onProgress?: ToolCallProgress<BashProgress>,
  ) {
    const timeoutMs = Math.min(
      input.timeout ?? getDefaultBashTimeoutMs(),
      getMaxBashTimeoutMs(),
    )
    const runInBackground = Boolean(input.run_in_background)
    const sandboxed = shouldUseSandbox(input)

    const shellCmd = await exec(
      input.command,
      context.abortController.signal,
      'bash',
      {
        timeoutMs,
        cwd: getCwd(),
        runInBackground,
        useSandbox: sandboxed,
        onProgress: onProgress
          ? progress => {
              onProgress({
                toolUseId: progress.taskId ?? 'bash',
                data: {
                  type: 'bash_progress',
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

    const annotatedStderr = sandboxed
      ? SandboxManager.annotateStderrWithSandboxFailures(
          input.command,
          result.stderr,
        )
      : result.stderr

    const semantics = interpretCommandResult(
      input.command,
      result.code,
      result.stdout,
      annotatedStderr,
    )

    if (result.code !== 0 && semantics.isError && !result.backgroundTaskId) {
      throw new ShellError(
        result.stdout,
        annotatedStderr,
        result.code,
        result.interrupted,
      )
    }

    const imageData = extractImageDataUri(result.stdout)
    const truncatedOut = truncateShellOutput(result.stdout)
    const truncatedErr = truncateShellOutput(annotatedStderr)

    return {
      data: {
        stdout: imageData ? result.stdout.trim() : truncatedOut.content,
        stderr: truncatedErr.content,
        interrupted: result.interrupted,
        isImage: imageData !== null,
        ...(semantics.message
          ? { returnCodeInterpretation: semantics.message }
          : {}),
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
        content: `Command running in background with ID: ${output.backgroundTaskId}.${output.backgroundTaskOutputPath ? ` Output file: ${output.backgroundTaskOutputPath}` : ''}`,
      }
    }

    if (output.isImage) {
      const parsed = extractImageDataUri(output.stdout)
      if (parsed) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: parsed.mediaType,
                data: parsed.base64,
              },
            },
          ],
        }
      }
    }

    const sections: string[] = []
    if (output.stdout) {
      sections.push(output.stdout.trimEnd())
    }
    if (output.stderr) {
      sections.push(output.stderr.trimEnd())
    }
    if (output.returnCodeInterpretation && sections.length === 0) {
      sections.push(output.returnCodeInterpretation)
    }
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

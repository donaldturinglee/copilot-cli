/**
 * Lightweight non-interactive shell command execution for prompt expansions.
 */

import { exec } from './shell.js'
import type { ShellKind } from './shell/shell_provider.js'

export async function executePromptShellCommand(
  command: string,
  options?: {
    timeoutMs?: number
    shellKind?: ShellKind
    abortSignal?: AbortSignal
  },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cmd = await exec(
    command,
    options?.abortSignal,
    options?.shellKind ?? 'bash',
    {
      timeoutMs: options?.timeoutMs ?? 15_000,
      persistCwd: false,
    },
  )
  const result = await cmd.result
  cmd.cleanup()
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
  }
}

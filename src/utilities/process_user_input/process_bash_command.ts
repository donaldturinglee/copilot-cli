import type { UUID } from 'crypto'
import type { UserMessage } from '../../types/message.js'
import { randomUUID } from '../crypto.js'
import { getCwd } from '../cwd.js'
import { exec as execShell } from '../shell.js'

export type BashCommandResult = {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  userMessage: UserMessage
}

export type BashExecutorFn = (
  command: string,
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>

async function defaultBashExecutor(
  command: string,
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const shellCmd = await execShell(command, options.signal, 'bash', {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 60_000,
  })
  const res = await shellCmd.result
  return {
    stdout: res.stdout,
    stderr: res.stderr,
    code: res.code,
  }
}

/**
 * Execute a `!command` direct shell command in the REPL and package its
 * `<bash-stdout>` / `<bash-stderr>` transcript tags into a `UserMessage`.
 */
export async function processBashCommand(
  rawInput: string,
  options?: {
    cwd?: string
    signal?: AbortSignal
    timeoutMs?: number
    executor?: BashExecutorFn
  },
): Promise<BashCommandResult> {
  const command = rawInput.startsWith('!') ? rawInput.slice(1).trim() : rawInput.trim()
  const cwd = options?.cwd ?? getCwd()
  const execFn = options?.executor ?? defaultBashExecutor

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  try {
    const res = await execFn(command, {
      cwd,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
    stdout = res.stdout
    stderr = res.stderr
    exitCode = res.code
  } catch (err) {
    stderr = err instanceof Error ? err.message : String(err)
    exitCode = 1
  }

  const taggedParts = [
    `<command-name>!${command}</command-name>`,
    stdout ? `<bash-stdout>${stdout}</bash-stdout>` : '',
    stderr ? `<bash-stderr>${stderr}</bash-stderr>` : '',
  ].filter(Boolean)

  const userMessage: UserMessage = {
    type: 'user',
    uuid: randomUUID() as UUID,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: taggedParts.join('\n'),
    },
  }

  return {
    command,
    stdout,
    stderr,
    exitCode,
    userMessage,
  }
}

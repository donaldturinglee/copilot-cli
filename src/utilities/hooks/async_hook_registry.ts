/**
 * Registry tracking asynchronous background command hooks (`async: true` /
 * `asyncRewake: true`), polling completion, parsing JSON output, and emitting
 * hook lifecycle events.
 */

import { existsSync, readFileSync } from 'fs'
import type {
  AsyncHookJSONOutput,
  HookEvent,
  SyncHookJSONOutput,
} from '../../types/hooks.js'
import { logForDebugging } from '../debug.js'
import type { ExecResult, ShellCommand } from '../shell_command.js'
import { jsonParse } from '../slow_operations.js'
import { emitHookResponse, startHookProgressInterval } from './hook_events.js'

export interface PendingAsyncHook {
  processId: string
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  startTime: number
  timeout: number
  command: string
  asyncRewake?: boolean
  responseAttachmentSent: boolean
  status: 'running' | 'completed' | 'killed'
  completedResult?: ExecResult
  shellCommand?: ShellCommand
  stopProgressInterval: () => void
}

export interface CompletedAsyncHookResponse {
  processId: string
  response: SyncHookJSONOutput
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  pluginId?: string
  stdout: string
  stderr: string
  exitCode?: number
  shouldRewake?: boolean
}

const pendingHooks = new Map<string, PendingAsyncHook>()

export function registerPendingAsyncHook(params: {
  processId: string
  hookId: string
  asyncResponse: AsyncHookJSONOutput
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  command: string
  shellCommand: ShellCommand
  toolName?: string
  pluginId?: string
  asyncRewake?: boolean
}): void {
  const timeout = params.asyncResponse.asyncTimeout ?? 15_000
  logForDebugging(
    `Hooks: Registering async hook ${params.processId} (${params.hookName}) timeout=${timeout}ms`,
  )

  const stopProgressInterval = startHookProgressInterval({
    hookId: params.hookId,
    hookName: params.hookName,
    hookEvent: params.hookEvent,
    getOutput: async () => {
      const entry = pendingHooks.get(params.processId)
      const outPath = entry?.shellCommand?.outputPath
      if (!outPath || !existsSync(outPath)) {
        return { stdout: '', stderr: '', output: '' }
      }
      try {
        const text = readFileSync(outPath, 'utf8')
        return { stdout: text, stderr: '', output: text }
      } catch {
        return { stdout: '', stderr: '', output: '' }
      }
    },
  })

  const record: PendingAsyncHook = {
    processId: params.processId,
    hookId: params.hookId,
    hookName: params.hookName,
    hookEvent: params.hookEvent,
    toolName: params.toolName,
    pluginId: params.pluginId,
    startTime: Date.now(),
    timeout,
    command: params.command,
    asyncRewake: params.asyncRewake,
    responseAttachmentSent: false,
    status: 'running',
    shellCommand: params.shellCommand,
    stopProgressInterval,
  }

  pendingHooks.set(params.processId, record)

  // Only treat `shellCommand.result` as final when NOT detached as a background task;
  // background tasks complete via `completePendingAsyncHook()` from `onBackgroundExit`.
  void params.shellCommand.result
    .then(res => {
      if (res.backgroundTaskId) return
      record.completedResult = res
      record.status = res.interrupted ? 'killed' : 'completed'
    })
    .catch(() => {
      record.status = 'killed'
    })
}

export function completePendingAsyncHook(
  processId: string,
  result: ExecResult,
): void {
  const record = pendingHooks.get(processId)
  if (!record) return
  record.completedResult = result
  record.status = result.interrupted ? 'killed' : 'completed'
}

export function getPendingAsyncHooks(): PendingAsyncHook[] {
  return Array.from(pendingHooks.values()).filter(h => !h.responseAttachmentSent)
}

export function clearAsyncHookRegistryForTesting(): void {
  for (const hook of pendingHooks.values()) {
    hook.stopProgressInterval()
    hook.shellCommand?.kill()
    hook.shellCommand?.cleanup()
  }
  pendingHooks.clear()
}

export async function checkForAsyncHookResponses(): Promise<
  CompletedAsyncHookResponse[]
> {
  const responses: CompletedAsyncHookResponse[] = []
  const snapshot = Array.from(pendingHooks.values())

  for (const hook of snapshot) {
    if (!hook.shellCommand) {
      hook.stopProgressInterval()
      pendingHooks.delete(hook.processId)
      continue
    }

    if (hook.status === 'killed') {
      hook.stopProgressInterval()
      hook.shellCommand.cleanup()
      pendingHooks.delete(hook.processId)
      continue
    }

    if (hook.status !== 'completed') {
      continue
    }

    const execResult = hook.completedResult ?? (await hook.shellCommand.result)
    let stdout = execResult.stdout
    if (!stdout && hook.shellCommand.outputPath && existsSync(hook.shellCommand.outputPath)) {
      try {
        stdout = readFileSync(hook.shellCommand.outputPath, 'utf8')
      } catch {
        // ignore
      }
    }
    const stderr = execResult.stderr
    const exitCode = execResult.code

    let parsedResponse: SyncHookJSONOutput = {}
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('{')) {
        try {
          const parsed = jsonParse(trimmed) as Record<string, unknown>
          if (!('async' in parsed)) {
            parsedResponse = parsed as SyncHookJSONOutput
            break
          }
        } catch {
          // Ignore non-JSON lines
        }
      }
    }

    hook.responseAttachmentSent = true
    hook.stopProgressInterval()
    hook.shellCommand.cleanup()
    pendingHooks.delete(hook.processId)

    emitHookResponse({
      hookId: hook.hookId,
      hookName: hook.hookName,
      hookEvent: hook.hookEvent,
      output: stdout + stderr,
      stdout,
      stderr,
      exitCode,
      outcome: exitCode === 0 ? 'success' : 'error',
    })

    responses.push({
      processId: hook.processId,
      response: parsedResponse,
      hookName: hook.hookName,
      hookEvent: hook.hookEvent,
      toolName: hook.toolName,
      pluginId: hook.pluginId,
      stdout,
      stderr,
      exitCode,
      shouldRewake: Boolean(hook.asyncRewake && exitCode === 2),
    })
  }

  return responses
}

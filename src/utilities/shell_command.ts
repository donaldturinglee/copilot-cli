/**
 * Process lifecycle wrapper (`ShellCommand`, `wrapSpawn`) providing:
 * - Merged / separate stdout & stderr capture backed by symlink-safe `TaskOutput`
 * - `tree-kill` process-tree cleanup on timeout, abort, or explicit kill
 * - Mid-execution progress updates (`onProgress`)
 * - Foreground-to-background detachment (`background(taskId)`)
 */

import type { ChildProcess } from 'child_process'
import treeKill from 'tree-kill'
import { generateTaskId } from './task/disk_output.js'
import { TaskOutput } from './task/task_output.js'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  interrupted: boolean
  backgroundTaskId?: string
  backgroundTaskOutputPath?: string
  backgroundedByUser?: boolean
  assistantAutoBackgrounded?: boolean
  returnCodeInterpretation?: string
}

export interface ShellCommandProgress {
  output: string
  fullOutput: string
  elapsedTimeSeconds: number
  totalLines: number
  totalBytes: number
  taskId?: string
}

export interface ShellCommand {
  readonly taskId: string
  readonly outputPath: string
  readonly result: Promise<ExecResult>
  kill(): void
  background(taskId?: string): { taskId: string; outputPath: string } | null
  cleanup(): void
}

export interface WrapSpawnOptions {
  timeoutMs: number
  abortSignal?: AbortSignal
  taskId?: string
  onProgress?: (progress: ShellCommandProgress) => void
  onBackgroundExit?: (result: ExecResult) => void
  progressIntervalMs?: number
}

/**
 * Terminates a process and its entire descendant tree safely across POSIX and
 * Windows using `tree-kill`.
 */
export function killProcessTree(
  pid: number | undefined,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
): void {
  if (!pid || pid <= 0) return
  try {
    treeKill(pid, signal, () => {
      // Escalate to SIGKILL if needed after grace period
      if (signal === 'SIGTERM') {
        const timer = setTimeout(() => {
          try {
            treeKill(pid, 'SIGKILL', () => {})
          } catch {
            // Process already exited
          }
        }, 1_500)
        timer.unref?.()
      }
    })
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Process already exited
    }
  }
}

/**
 * Wraps a spawned `ChildProcess` in a managed `ShellCommand` lifecycle.
 */
export function wrapSpawn(
  child: ChildProcess,
  options: WrapSpawnOptions,
): ShellCommand {
  const taskId = options.taskId ?? generateTaskId()
  const taskOutput = new TaskOutput(taskId)
  const startTime = Date.now()
  const progressIntervalMs = options.progressIntervalMs ?? 500

  let stdout = ''
  let stderr = ''
  let totalLines = 0
  let interrupted = false
  let timedOut = false
  let sizeExceeded = false
  let finished = false
  let backgrounded = false
  let activeTaskId = taskId

  let resolveForeground!: (result: ExecResult) => void
  const foregroundPromise = new Promise<ExecResult>(resolve => {
    resolveForeground = resolve
  })

  const emitProgress = () => {
    if (!options.onProgress || finished || backgrounded) return
    const combined = stdout + (stderr ? (stdout ? '\n' : '') + stderr : '')
    const tail =
      combined.length > 2000 ? combined.slice(combined.length - 2000) : combined
    options.onProgress({
      output: tail,
      fullOutput: combined,
      elapsedTimeSeconds: Math.round((Date.now() - startTime) / 100) / 10,
      totalLines,
      totalBytes: taskOutput.getTotalBytes(),
      taskId: activeTaskId,
    })
  }

  const progressTimer = options.onProgress
    ? setInterval(emitProgress, progressIntervalMs)
    : undefined
  progressTimer?.unref?.()

  const terminateChild = () => {
    killProcessTree(child.pid, 'SIGTERM')
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
    const forceTimer = setTimeout(() => {
      if (finished) return
      killProcessTree(child.pid, 'SIGKILL')
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
      finalize(143)
    }, 500)
    forceTimer.unref?.()
  }

  const kill = () => {
    if (finished) return
    interrupted = true
    terminateChild()
  }

  const onAbort = () => {
    if (finished || backgrounded) return
    interrupted = true
    terminateChild()
  }

  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      onAbort()
    } else {
      options.abortSignal.addEventListener('abort', onAbort, { once: true })
    }
  }

  const timeoutTimer =
    options.timeoutMs > 0 && Number.isFinite(options.timeoutMs)
      ? setTimeout(() => {
          if (finished || backgrounded) return
          timedOut = true
          interrupted = true
          terminateChild()
        }, options.timeoutMs)
      : undefined
  timeoutTimer?.unref?.()

  const countNewlines = (chunk: string): number => {
    let count = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 10) count++
    }
    return count
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    totalLines += countNewlines(chunk)
    taskOutput.appendStdout(chunk)
    if (stdout.length < 512 * 1024) {
      stdout += chunk
    }
    if (taskOutput.exceedsMaxDiskSize() && !sizeExceeded) {
      sizeExceeded = true
      interrupted = true
      killProcessTree(child.pid, 'SIGTERM')
    }
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    totalLines += countNewlines(chunk)
    taskOutput.appendStderr(chunk)
    if (stderr.length < 512 * 1024) {
      stderr += chunk
    }
    if (taskOutput.exceedsMaxDiskSize() && !sizeExceeded) {
      sizeExceeded = true
      interrupted = true
      killProcessTree(child.pid, 'SIGTERM')
    }
  })

  const cleanupTimers = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (progressTimer) clearInterval(progressTimer)
    options.abortSignal?.removeEventListener('abort', onAbort)
  }

  const finalize = (exitCode: number, spawnError?: Error) => {
    if (finished) return
    finished = true
    cleanupTimers()
    taskOutput.close()

    let finalStderr = stderr
    if (spawnError) {
      finalStderr = finalStderr
        ? `${finalStderr}\n${spawnError.message}`
        : spawnError.message
    } else if (timedOut) {
      const secs = Math.round(options.timeoutMs / 1000)
      const msg = `Command timed out after ${secs}s`
      finalStderr = finalStderr ? `${finalStderr}\n${msg}` : msg
    } else if (sizeExceeded) {
      const msg = 'Command terminated because output exceeded 5GB disk limit'
      finalStderr = finalStderr ? `${finalStderr}\n${msg}` : msg
    }

    const finalResult: ExecResult = {
      code: spawnError ? 1 : exitCode,
      stdout,
      stderr: finalStderr,
      interrupted,
    }

    if (backgrounded) {
      options.onBackgroundExit?.(finalResult)
    } else {
      resolveForeground(finalResult)
    }
  }

  child.on('error', err => finalize(1, err))
  child.on('close', code => finalize(code ?? (interrupted ? 143 : 0)))

  const background = (overrideTaskId?: string) => {
    if (finished || backgrounded) {
      return null
    }
    backgrounded = true
    if (overrideTaskId) {
      activeTaskId = overrideTaskId
    }
    cleanupTimers()
    // Detach foreground promise immediately; child keeps streaming to disk
    resolveForeground({
      code: 0,
      stdout,
      stderr,
      interrupted: false,
      backgroundTaskId: activeTaskId,
      backgroundTaskOutputPath: taskOutput.path,
      assistantAutoBackgrounded: true,
    })
    return { taskId: activeTaskId, outputPath: taskOutput.path }
  }

  return {
    taskId,
    outputPath: taskOutput.path,
    result: foregroundPromise,
    kill,
    background,
    cleanup() {
      taskOutput.cleanup()
    },
  }
}

export function createAbortedCommand(taskId: string = generateTaskId()): ShellCommand {
  return {
    taskId,
    outputPath: '',
    result: Promise.resolve({
      code: 130,
      stdout: '',
      stderr: 'Command aborted before execution',
      interrupted: true,
    }),
    kill() {},
    background() {
      return null
    },
    cleanup() {},
  }
}

export function createFailedCommand(
  message: string,
  code = 1,
  taskId: string = generateTaskId(),
): ShellCommand {
  return {
    taskId,
    outputPath: '',
    result: Promise.resolve({
      code,
      stdout: '',
      stderr: message,
      interrupted: false,
    }),
    kill() {},
    background() {
      return null
    },
    cleanup() {},
  }
}

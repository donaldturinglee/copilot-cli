/**
 * Hook progress & response event emitters for SDK / TUI telemetry streams.
 */

import type { HookEvent } from '../../types/hooks.js'
import { enqueueSdkEvent } from '../sdk_event_queue.js'

export interface HookResponseEvent {
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}

export function emitHookStarted(params: {
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
}): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'hook_started',
    hook_id: params.hookId,
    hook_name: params.hookName,
    hook_event: params.hookEvent,
  })
}

export function emitHookResponse(event: HookResponseEvent): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'hook_response',
    hook_id: event.hookId,
    hook_name: event.hookName,
    hook_event: event.hookEvent,
    output: event.output,
    stdout: event.stdout,
    stderr: event.stderr,
    exit_code: event.exitCode,
    outcome: event.outcome,
  })
}

export function startHookProgressInterval(params: {
  hookId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  getOutput: () => Promise<{ stdout: string; stderr: string; output: string }>
  intervalMs?: number
}): () => void {
  const timer = setInterval(() => {
    void params
      .getOutput()
      .then(({ stdout, stderr, output }) => {
        if (!output) return
        enqueueSdkEvent({
          type: 'system',
          subtype: 'hook_progress',
          hook_id: params.hookId,
          hook_name: params.hookName,
          hook_event: params.hookEvent,
          stdout,
          stderr,
          output,
        })
      })
      .catch(() => {
        // Ignore progress read errors
      })
  }, params.intervalMs ?? 5_000)

  if (typeof timer.unref === 'function') {
    timer.unref()
  }

  return () => {
    clearInterval(timer)
  }
}

import { createAbortController } from './abort_controller.js'

/**
 * Creates a combined AbortSignal that aborts when the input signal aborts,
 * an optional second signal aborts, or an optional timeout elapses.
 */
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const { signalB, timeoutMs } = opts ?? {}
  const combined = createAbortController()

  if (signal?.aborted || signalB?.aborted) {
    combined.abort()
    return { signal: combined.signal, cleanup: () => {} }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const abortCombined = () => {
    if (timer !== undefined) clearTimeout(timer)
    combined.abort()
  }

  if (timeoutMs !== undefined) {
    timer = setTimeout(abortCombined, timeoutMs)
    timer.unref?.()
  }
  signal?.addEventListener('abort', abortCombined)
  signalB?.addEventListener('abort', abortCombined)

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abortCombined)
    signalB?.removeEventListener('abort', abortCombined)
  }

  return { signal: combined.signal, cleanup }
}

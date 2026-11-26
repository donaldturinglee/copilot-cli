import { logForDebugging } from './debug.js'
import { gracefulShutdownSync } from './graceful_shutdown.js'

export function createIdleTimeoutManager(isIdle: () => boolean): {
  start: () => void
  stop: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastIdleTime = 0

  function stop(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function start(): void {
    stop()
    const rawDelay = process.env.COPILOT_CLI_EXIT_AFTER_STOP_DELAY
    if (!rawDelay) return
    const delayMs = parseInt(rawDelay, 10)
    if (Number.isNaN(delayMs) || delayMs <= 0) return

    lastIdleTime = Date.now()
    timer = setTimeout(() => {
      timer = null
      if (isIdle() && Date.now() - lastIdleTime >= delayMs) {
        logForDebugging(
          `Idle timeout (${delayMs}ms) reached; initiating graceful shutdown`,
        )
        gracefulShutdownSync(0)
      }
    }, delayMs)
    timer.unref?.()
  }

  return { start, stop }
}

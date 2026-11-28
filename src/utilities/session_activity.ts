/**
 * Remote session activity keep-alive heartbeat signal registry (used during
 * long-running operations like LLM compaction).
 */

type ActivitySignalHandler = () => void

let activitySignalHandler: ActivitySignalHandler | null = null
let activityTrackingActive = false

/**
 * Registers a handler invoked when long-running tasks emit keep-alive signals.
 */
export function setSessionActivitySignalHandler(
  handler: ActivitySignalHandler | null,
): void {
  activitySignalHandler = handler
  activityTrackingActive = handler !== null
}

/**
 * Returns `true` when remote session activity keep-alive tracking is active.
 */
export function isSessionActivityTrackingActive(): boolean {
  return activityTrackingActive
}

/**
 * Emits a keep-alive activity pulse to prevent idle disconnects during long work.
 */
export function sendSessionActivitySignal(): void {
  activitySignalHandler?.()
}

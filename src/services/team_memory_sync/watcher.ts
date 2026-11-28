/**
 * Debounced background watcher for team memory writes
 * (`src/services/team_memory_sync/watcher.ts`):
 * - Pulls remote team memory on session startup
 * - Coalesces local write notifications with a `2,000ms` debounce window
 * - Suppresses retries after permanent 4xx errors (except 409/412/429)
 */

import { registerCleanup } from '../../utilities/cleanup_registry.js'
import { logForDebugging } from '../../utilities/debug.js'
import {
  createSyncState,
  isTeamMemorySyncAvailable,
  pullTeamMemory,
  pushTeamMemory,
  type TeamMemorySyncOptions,
} from './index.js'
import type { SyncState } from './types.js'

export const DEBOUNCE_MS = 2_000

let active = false
let permanentlyFailed = false
let syncState: SyncState = createSyncState()
let syncOptions: TeamMemorySyncOptions | undefined
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let inFlightPush: Promise<void> | null = null
let pendingPush = false
let unregisterCleanup: (() => void) | undefined

function isPermanentHttpFailure(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return false
  if (statusCode < 400 || statusCode >= 500) return false
  return statusCode !== 409 && statusCode !== 412 && statusCode !== 429
}

async function executePushCycle(): Promise<void> {
  if (!active || permanentlyFailed) {
    return
  }

  if (inFlightPush) {
    pendingPush = true
    return
  }

  const run = (async () => {
    try {
      const result = await pushTeamMemory(syncState, syncOptions)
      if (!result.success && isPermanentHttpFailure(result.statusCode)) {
        permanentlyFailed = true
        logForDebugging(
          `Team memory watcher disabled after HTTP ${result.statusCode}`,
        )
      }
    } finally {
      inFlightPush = null
      if (pendingPush && active && !permanentlyFailed) {
        pendingPush = false
        void executePushCycle()
      }
    }
  })()

  inFlightPush = run
  await run
}

/**
 * Starts the team memory watcher, performs an initial remote pull, and
 * registers graceful shutdown cleanup.
 */
export async function startTeamMemoryWatcher(
  options?: TeamMemorySyncOptions,
): Promise<boolean> {
  if (active) {
    return true
  }
  if (!(await isTeamMemorySyncAvailable(options))) {
    return false
  }

  active = true
  permanentlyFailed = false
  syncState = createSyncState()
  syncOptions = options

  unregisterCleanup = registerCleanup(async () => {
    await stopTeamMemoryWatcher()
  })

  const pullResult = await pullTeamMemory(syncState, syncOptions)
  if (!pullResult.success && isPermanentHttpFailure(pullResult.statusCode)) {
    permanentlyFailed = true
    logForDebugging(
      `Team memory initial pull permanently failed (HTTP ${pullResult.statusCode})`,
    )
  }

  return true
}

/**
 * Notifies the watcher that a local team memory file was written or edited,
 * scheduling a debounced push (`2,000ms`).
 */
export function notifyTeamMemoryWrite(debounceMs: number = DEBOUNCE_MS): void {
  if (!active || permanentlyFailed) {
    return
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined
    void executePushCycle()
  }, debounceMs)
  debounceTimer.unref?.()
}

/**
 * Flushes any pending push and stops the team memory watcher.
 */
export async function stopTeamMemoryWatcher(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
    if (active && !permanentlyFailed) {
      await executePushCycle()
    }
  }
  if (inFlightPush) {
    await inFlightPush
  }
  active = false
  pendingPush = false
  unregisterCleanup?.()
  unregisterCleanup = undefined
}

export function isTeamMemoryWatcherActive(): boolean {
  return active && !permanentlyFailed
}

export function getTeamMemoryWatcherStateForTesting(): {
  active: boolean
  permanentlyFailed: boolean
  syncState: SyncState
} {
  return { active, permanentlyFailed, syncState }
}

export function resetWatcherStateForTesting(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
  active = false
  permanentlyFailed = false
  syncState = createSyncState()
  syncOptions = undefined
  inFlightPush = null
  pendingPush = false
  unregisterCleanup?.()
  unregisterCleanup = undefined
}

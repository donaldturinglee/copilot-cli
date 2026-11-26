/**
 * Synchronous 3-state query lifecycle guard (`idle` | `dispatching` | `running`)
 * with monotonic generation counters and React `useSyncExternalStore` bindings.
 */

import { createSignal } from './signal.js'

export type QueryGuardStatus = 'idle' | 'dispatching' | 'running'

/**
 * Prevents concurrent overlapping turns and invalidates stale `finally` cleanups.
 */
export class QueryGuard {
  private status: QueryGuardStatus = 'idle'
  private currentGeneration = 0
  private readonly changed = createSignal()

  readonly subscribe = this.changed.subscribe

  readonly getSnapshot = (): boolean => this.status !== 'idle'

  get isActive(): boolean {
    return this.status !== 'idle'
  }

  get generation(): number {
    return this.currentGeneration
  }

  /**
   * Reserves dispatch from `idle` -> `dispatching`. Returns `false` if already active.
   */
  reserve(): boolean {
    if (this.status !== 'idle') {
      return false
    }
    this.status = 'dispatching'
    this.changed.emit()
    return true
  }

  /**
   * Cancels a `dispatching` reservation back to `idle`.
   */
  cancelReservation(): void {
    if (this.status !== 'dispatching') {
      return
    }
    this.status = 'idle'
    this.changed.emit()
  }

  /**
   * Transitions `idle` or `dispatching` -> `running` and returns a unique
   * generation token, or `null` if already running.
   */
  tryStart(): number | null {
    if (this.status === 'running') {
      return null
    }
    this.status = 'running'
    this.currentGeneration++
    this.changed.emit()
    return this.currentGeneration
  }

  /**
   * Transitions `running` -> `idle` only if `generation` matches the active run.
   * Returns `true` when the caller owns cleanup, `false` for stale `finally` blocks.
   */
  end(generation: number): boolean {
    if (this.status !== 'running' || this.currentGeneration !== generation) {
      return false
    }
    this.status = 'idle'
    this.changed.emit()
    return true
  }

  /**
   * Forces any active state back to `idle` and bumps generation to invalidate
   * in-flight `finally` blocks.
   */
  forceEnd(): void {
    if (this.status === 'idle') {
      return
    }
    this.status = 'idle'
    this.currentGeneration++
    this.changed.emit()
  }
}

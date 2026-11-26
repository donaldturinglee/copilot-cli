import { getActiveTimeCounter as getActiveTimeCounterImpl } from '../bootstrap/state.js'

const USER_ACTIVITY_TIMEOUT_MS = 5000

type ActivityManagerOptions = {
  getNow?: () => number
  getActiveTimeCounter?: typeof getActiveTimeCounterImpl
}

/**
 * Handles generic activity tracking for both user and CLI operations.
 * Automatically deduplicates overlapping activities and records separate
 * metrics for user vs CLI active time.
 */
export class ActivityManager {
  private activeOperations = new Set<string>()
  private lastUserActivityTime = 0
  private lastCliRecordedTime: number
  private isCliActive = false
  private readonly getNow: () => number
  private readonly getActiveTimeCounter: typeof getActiveTimeCounterImpl

  private static instance: ActivityManager | null = null

  constructor(options?: ActivityManagerOptions) {
    this.getNow = options?.getNow ?? (() => Date.now())
    this.getActiveTimeCounter =
      options?.getActiveTimeCounter ?? getActiveTimeCounterImpl
    this.lastCliRecordedTime = this.getNow()
  }

  static getInstance(): ActivityManager {
    if (!ActivityManager.instance) {
      ActivityManager.instance = new ActivityManager()
    }
    return ActivityManager.instance
  }

  static resetInstance(): void {
    ActivityManager.instance = null
  }

  static createInstance(options?: ActivityManagerOptions): ActivityManager {
    ActivityManager.instance = new ActivityManager(options)
    return ActivityManager.instance
  }

  recordUserActivity(): void {
    if (!this.isCliActive && this.lastUserActivityTime !== 0) {
      const now = this.getNow()
      const timeSinceLastActivity = (now - this.lastUserActivityTime) / 1000

      if (timeSinceLastActivity > 0) {
        const activeTimeCounter = this.getActiveTimeCounter()
        if (activeTimeCounter) {
          const timeoutSeconds = USER_ACTIVITY_TIMEOUT_MS / 1000
          if (timeSinceLastActivity < timeoutSeconds) {
            activeTimeCounter.add(timeSinceLastActivity, { type: 'user' })
          }
        }
      }
    }

    this.lastUserActivityTime = this.getNow()
  }

  startCliActivity(operationId: string): void {
    if (this.activeOperations.has(operationId)) {
      this.endCliActivity(operationId)
    }

    const wasEmpty = this.activeOperations.size === 0
    this.activeOperations.add(operationId)

    if (wasEmpty) {
      this.isCliActive = true
      this.lastCliRecordedTime = this.getNow()
    }
  }

  endCliActivity(operationId: string): void {
    this.activeOperations.delete(operationId)

    if (this.activeOperations.size === 0) {
      const now = this.getNow()
      const timeSinceLastRecord = (now - this.lastCliRecordedTime) / 1000

      if (timeSinceLastRecord > 0) {
        const activeTimeCounter = this.getActiveTimeCounter()
        if (activeTimeCounter) {
          activeTimeCounter.add(timeSinceLastRecord, { type: 'cli' })
        }
      }

      this.lastCliRecordedTime = now
      this.isCliActive = false
    }
  }

  async trackOperation<Result>(
    operationId: string,
    fn: () => Promise<Result>,
  ): Promise<Result> {
    this.startCliActivity(operationId)
    try {
      return await fn()
    } finally {
      this.endCliActivity(operationId)
    }
  }

  getActivityStates(): {
    isUserActive: boolean
    isCliActive: boolean
    activeOperationCount: number
  } {
    const now = this.getNow()
    const timeSinceUserActivity = (now - this.lastUserActivityTime) / 1000
    const isUserActive =
      timeSinceUserActivity < USER_ACTIVITY_TIMEOUT_MS / 1000

    return {
      isUserActive,
      isCliActive: this.isCliActive,
      activeOperationCount: this.activeOperations.size,
    }
  }
}

export const activityManager = ActivityManager.getInstance()

import type * as React from 'react'
import { useCallback, useEffect } from 'react'
import { useAppStateStore, useSetAppState } from '../state/app_state.js'
import type { Notification as ForwardNotification } from '../types/forward.js'
import type { Theme } from '../utilities/theme.js'

export type NotificationPriority = 'low' | 'medium' | 'high' | 'immediate'

type BaseNotification = {
  key: string
  invalidates?: string[]
  priority: NotificationPriority
  timeoutMs?: number
  fold?: (accumulator: Notification, incoming: Notification) => Notification
}

export type TextNotification = BaseNotification & {
  text: string
  color?: keyof Theme
}

export type JSXNotification = BaseNotification & {
  jsx: React.ReactNode
}

export type Notification = TextNotification | JSXNotification

const DEFAULT_TIMEOUT_MS = 8000

const PRIORITY_RANK: Record<NotificationPriority, number> = {
  immediate: 3,
  high: 2,
  medium: 1,
  low: 0,
}

export function pickNextNotification(
  queue: readonly Notification[],
): Notification | undefined {
  let best: Notification | undefined
  let bestRank = -1
  for (const item of queue) {
    const rank = PRIORITY_RANK[item.priority] ?? 0
    if (rank > bestRank) {
      best = item
      bestRank = rank
    }
  }
  return best
}

let currentTimeoutId: ReturnType<typeof setTimeout> | null = null

export function clearPendingNotificationTimer(): void {
  if (currentTimeoutId) {
    clearTimeout(currentTimeoutId)
    currentTimeoutId = null
  }
}

export function useNotifications(): {
  addNotification: (content: Notification) => void
  removeNotification: (key: string) => void
} {
  const store = useAppStateStore()
  const setAppState = useSetAppState()

  const processQueue = useCallback(() => {
    setAppState(prev => {
      const queue = prev.notifications.queue as unknown as Notification[]
      const current = prev.notifications.current as unknown as Notification | null
      const next = pickNextNotification(queue)
      if (current !== null || !next) {
        return prev
      }

      clearPendingNotificationTimer()
      currentTimeoutId = setTimeout(() => {
        currentTimeoutId = null
        setAppState(p => {
          const cur = p.notifications.current as unknown as Notification | null
          if (cur?.key !== next.key) return p
          return {
            ...p,
            notifications: {
              queue: p.notifications.queue,
              current: null,
            },
          }
        })
        processQueue()
      }, next.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      if (typeof currentTimeoutId.unref === 'function') {
        currentTimeoutId.unref()
      }

      return {
        ...prev,
        notifications: {
          queue: queue.filter(n => n !== next) as unknown as ForwardNotification[],
          current: next as unknown as ForwardNotification,
        },
      }
    })
  }, [setAppState])

  const addNotification = useCallback(
    (notif: Notification) => {
      if (notif.priority === 'immediate') {
        clearPendingNotificationTimer()
        currentTimeoutId = setTimeout(() => {
          currentTimeoutId = null
          setAppState(prev => {
            const cur = prev.notifications.current as unknown as Notification | null
            if (cur?.key !== notif.key) return prev
            const q = prev.notifications.queue as unknown as Notification[]
            return {
              ...prev,
              notifications: {
                queue: q.filter(
                  n => !notif.invalidates?.includes(n.key),
                ) as unknown as ForwardNotification[],
                current: null,
              },
            }
          })
          processQueue()
        }, notif.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        if (typeof currentTimeoutId.unref === 'function') {
          currentTimeoutId.unref()
        }

        setAppState(prev => {
          const cur = prev.notifications.current as unknown as Notification | null
          const q = prev.notifications.queue as unknown as Notification[]
          const reQueued = [
            ...(cur ? [cur] : []),
            ...q,
          ].filter(
            n =>
              n.priority !== 'immediate' &&
              !notif.invalidates?.includes(n.key),
          )
          return {
            ...prev,
            notifications: {
              current: notif as unknown as ForwardNotification,
              queue: reQueued as unknown as ForwardNotification[],
            },
          }
        })
        return
      }

      setAppState(prev => {
        const cur = prev.notifications.current as unknown as Notification | null
        const q = prev.notifications.queue as unknown as Notification[]

        if (notif.fold) {
          if (cur?.key === notif.key) {
            const folded = notif.fold(cur, notif)
            clearPendingNotificationTimer()
            currentTimeoutId = setTimeout(() => {
              currentTimeoutId = null
              setAppState(p => {
                const c = p.notifications.current as unknown as Notification | null
                if (c?.key !== folded.key) return p
                return {
                  ...p,
                  notifications: { queue: p.notifications.queue, current: null },
                }
              })
              processQueue()
            }, folded.timeoutMs ?? DEFAULT_TIMEOUT_MS)
            if (typeof currentTimeoutId.unref === 'function') {
              currentTimeoutId.unref()
            }
            return {
              ...prev,
              notifications: {
                current: folded as unknown as ForwardNotification,
                queue: prev.notifications.queue,
              },
            }
          }

          const idx = q.findIndex(n => n.key === notif.key)
          if (idx !== -1) {
            const folded = notif.fold(q[idx]!, notif)
            const nextQueue = [...q]
            nextQueue[idx] = folded
            return {
              ...prev,
              notifications: {
                current: prev.notifications.current,
                queue: nextQueue as unknown as ForwardNotification[],
              },
            }
          }
        }

        const queuedKeys = new Set(q.map(n => n.key))
        if (queuedKeys.has(notif.key) || cur?.key === notif.key) {
          return prev
        }

        const invalidatesCurrent =
          cur !== null && Boolean(notif.invalidates?.includes(cur.key))
        if (invalidatesCurrent) {
          clearPendingNotificationTimer()
        }

        const filtered = q.filter(
          n =>
            n.priority !== 'immediate' &&
            !notif.invalidates?.includes(n.key),
        )
        return {
          ...prev,
          notifications: {
            current: invalidatesCurrent ? null : prev.notifications.current,
            queue: [...filtered, notif] as unknown as ForwardNotification[],
          },
        }
      })

      processQueue()
    },
    [setAppState, processQueue],
  )

  const removeNotification = useCallback(
    (key: string) => {
      setAppState(prev => {
        const cur = prev.notifications.current as unknown as Notification | null
        const q = prev.notifications.queue as unknown as Notification[]
        const isCurrent = cur?.key === key
        const inQueue = q.some(n => n.key === key)
        if (!isCurrent && !inQueue) return prev
        if (isCurrent) {
          clearPendingNotificationTimer()
        }
        return {
          ...prev,
          notifications: {
            current: isCurrent ? null : prev.notifications.current,
            queue: q.filter(n => n.key !== key) as unknown as ForwardNotification[],
          },
        }
      })
      processQueue()
    },
    [setAppState, processQueue],
  )

  useEffect(() => {
    if (store.getState().notifications.queue.length > 0) {
      processQueue()
    }
  }, [store, processQueue])

  return { addNotification, removeNotification }
}

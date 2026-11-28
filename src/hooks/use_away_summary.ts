/**
 * React hook scheduling an away-from-keyboard session recap (`useAwaySummary`)
 * after `5` minutes of terminal blur, cancelling cleanly on refocus.
 */

import { useEffect, useRef } from 'react'
import {
  getTerminalFocused,
  subscribeTerminalFocus,
} from '../ink/terminal_focus_state.js'
import {
  type AwaySummaryQueryFn,
  createAwaySummaryMessage,
  generateAwaySummary,
} from '../services/away_summary.js'
import type { Message } from '../types/message.js'

export const BLUR_DELAY_MS = 5 * 60_000

/**
 * Returns `true` if an `away_summary` system message has already been appended
 * since the most recent non-meta user message.
 */
export function hasSummarySinceLastUserTurn(
  messages: readonly Message[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'system' && msg.subtype === 'away_summary') {
      return true
    }
    if (msg.type === 'user' && !msg.isMeta) {
      return false
    }
  }
  return false
}

export interface UseAwaySummaryOptions {
  enabled?: boolean
  blurDelayMs?: number
  queryFn?: AwaySummaryQueryFn
}

/**
 * Subscribes to terminal focus changes; if the terminal stays blurred for
 * `BLUR_DELAY_MS` (5m) while idle and no recap exists since the last user turn,
 * generates and appends a `SystemAwaySummaryMessage`.
 */
export function useAwaySummary(
  messages: readonly Message[],
  setMessages: (updater: (prev: Message[]) => Message[]) => void,
  isLoading: boolean,
  options?: UseAwaySummaryOptions,
): void {
  const enabled = options?.enabled ?? true
  const blurDelayMs = options?.blurDelayMs ?? BLUR_DELAY_MS
  const queryFn = options?.queryFn

  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading

  useEffect(() => {
    if (!enabled) {
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let abortController: AbortController | undefined

    const cancelPending = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (abortController) {
        abortController.abort()
        abortController = undefined
      }
    }

    const scheduleSummary = (): void => {
      cancelPending()
      timer = setTimeout(() => {
        timer = undefined
        if (getTerminalFocused() || isLoadingRef.current) {
          return
        }
        const currentMessages = messagesRef.current
        if (
          currentMessages.length === 0 ||
          hasSummarySinceLastUserTurn(currentMessages)
        ) {
          return
        }

        const controller = new AbortController()
        abortController = controller
        void generateAwaySummary(currentMessages, controller.signal, {
          queryFn,
        }).then(summary => {
          if (!summary || controller.signal.aborted) {
            return
          }
          setMessages(prev => {
            if (hasSummarySinceLastUserTurn(prev)) {
              return prev
            }
            return [...prev, createAwaySummaryMessage(summary)]
          })
        })
      }, blurDelayMs)
      timer.unref?.()
    }

    if (!getTerminalFocused()) {
      scheduleSummary()
    }

    const unsubscribe = subscribeTerminalFocus(focused => {
      if (focused) {
        cancelPending()
      } else {
        scheduleSummary()
      }
    })

    return () => {
      unsubscribe()
      cancelPending()
    }
  }, [enabled, blurDelayMs, queryFn, setMessages])
}

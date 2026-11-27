/**
 * Session-scoped dynamic hook registration (used by skills, agents, and
 * programmatic callers in `AppState.sessionHooks`).
 */

import type { HookCommand } from '../../schemas/hooks.js'
import type { AppState } from '../../state/app_state_store.js'
import type { HookCallback, HookEvent, HookFunction } from '../../types/hooks.js'

export type RegisteredSessionHook = HookCommand | HookCallback | HookFunction

export interface SessionHookEntry {
  matcher: string
  hooks: Array<{
    hook: RegisteredSessionHook
    onHookSuccess?: () => void
    skillRoot?: string
  }>
}

interface SessionHooksBucket {
  hooks: Partial<Record<HookEvent, SessionHookEntry[]>>
}

export interface SessionHookRecord {
  matcher: string
  hook: RegisteredSessionHook
  once?: boolean
  skillRoot?: string
  pluginName?: string
  onHookSuccess?: () => void
}

function asBucket(raw: unknown): SessionHooksBucket {
  if (raw && typeof raw === 'object' && 'hooks' in raw) {
    return raw as SessionHooksBucket
  }
  return { hooks: {} }
}

export function addSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: RegisteredSessionHook,
  options?: {
    skillRoot?: string
    pluginName?: string
    onHookSuccess?: () => void
  },
): void {
  setAppState(prev => {
    const existingSession = asBucket(prev.sessionHooks.get(sessionId))
    const existingList = existingSession.hooks[event] ?? []
    const entry: SessionHookEntry = {
      matcher,
      hooks: [
        {
          hook,
          onHookSuccess: options?.onHookSuccess,
          skillRoot: options?.skillRoot,
        },
      ],
    }
    const nextMap = new Map(prev.sessionHooks)
    const nextBucket: SessionHooksBucket = {
      hooks: {
        ...existingSession.hooks,
        [event]: [...existingList, entry],
      },
    }
    nextMap.set(sessionId, nextBucket)
    return {
      ...prev,
      sessionHooks: nextMap,
    }
  })
}

export function getSessionHooks(
  appState: AppState,
  sessionId: string,
  event: HookEvent,
): SessionHookRecord[] {
  const raw = appState.sessionHooks.get(sessionId)
  if (!raw) return []
  const session = asBucket(raw)
  const entries = session.hooks[event] ?? []
  const out: SessionHookRecord[] = []
  for (const entry of entries) {
    for (const item of entry.hooks) {
      out.push({
        matcher: entry.matcher,
        hook: item.hook,
        skillRoot: item.skillRoot,
        onHookSuccess: item.onHookSuccess,
      })
    }
  }
  return out
}

export function clearSessionHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): void {
  setAppState(prev => {
    if (!prev.sessionHooks.has(sessionId)) return prev
    const nextMap = new Map(prev.sessionHooks)
    nextMap.delete(sessionId)
    return {
      ...prev,
      sessionHooks: nextMap,
    }
  })
}

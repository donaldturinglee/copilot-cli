/**
 * Registration helpers for frontmatter-declared hooks (agents & skills).
 */

import type { HooksSettings } from '../../schemas/hooks.js'
import type { AppState } from '../../state/app_state_store.js'
import type { HookEvent } from '../../types/hooks.js'
import { addSessionHook } from './session_hooks.js'

export function registerFrontmatterHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings | undefined,
  options?: { skillRoot?: string; pluginName?: string },
): void {
  if (!hooks) return
  for (const [eventKey, matchers] of Object.entries(hooks)) {
    if (!matchers) continue
    const event = eventKey as HookEvent
    for (const matcher of matchers) {
      for (const hook of matcher.hooks) {
        addSessionHook(
          setAppState,
          sessionId,
          event,
          matcher.matcher ?? '*',
          hook,
          options,
        )
      }
    }
  }
}

/**
 * Skill-scoped hook registration helper delegating to frontmatter hook registration.
 */

import type { HooksSettings } from '../../schemas/hooks.js'
import type { AppState } from '../../state/app_state_store.js'
import { registerFrontmatterHooks } from './register_frontmatter_hooks.js'

export function registerSkillHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  skillRoot: string,
  hooks: HooksSettings | undefined,
): void {
  registerFrontmatterHooks(setAppState, sessionId, hooks, { skillRoot })
}

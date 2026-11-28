/**
 * Initializes all built-in bundled skills at CLI startup.
 */

import {
  getBundledSkillCommands,
  registerBundledSkill,
} from '../bundled_skills.js'

export { getBundledSkillCommands }
import { batchBundledSkill } from './batch.js'
import { claudeApiBundledSkill } from './claude_api.js'
import { claudeInChromeBundledSkill } from './claude_in_chrome.js'
import { debugBundledSkill } from './debug.js'
import { keybindingsBundledSkill } from './keybindings.js'
import { loopBundledSkill } from './loop.js'
import { loremIpsumBundledSkill } from './lorem_ipsum.js'
import { rememberBundledSkill } from './remember.js'
import { scheduleRemoteAgentsBundledSkill } from './schedule_remote_agents.js'
import { simplifyBundledSkill } from './simplify.js'
import { skillifyBundledSkill } from './skillify.js'
import { stuckBundledSkill } from './stuck.js'
import { updateConfigBundledSkill } from './update_config.js'
import { verifyBundledSkill } from './verify.js'

let initialized = false

/**
 * Registers all 14 bundled skills idempotently.
 */
export function initBundledSkills(): void {
  if (initialized) {
    return
  }
  initialized = true

  registerBundledSkill(updateConfigBundledSkill)
  registerBundledSkill(keybindingsBundledSkill)
  registerBundledSkill(verifyBundledSkill)
  registerBundledSkill(debugBundledSkill)
  registerBundledSkill(loremIpsumBundledSkill)
  registerBundledSkill(skillifyBundledSkill)
  registerBundledSkill(rememberBundledSkill)
  registerBundledSkill(simplifyBundledSkill)
  registerBundledSkill(batchBundledSkill)
  registerBundledSkill(stuckBundledSkill)
  registerBundledSkill(loopBundledSkill)
  registerBundledSkill(scheduleRemoteAgentsBundledSkill)
  registerBundledSkill(claudeApiBundledSkill)
  registerBundledSkill(claudeInChromeBundledSkill)
}

/**
 * Resets the `initialized` latch for isolated unit tests.
 */
export function resetBundledSkillsInitForTesting(): void {
  initialized = false
}

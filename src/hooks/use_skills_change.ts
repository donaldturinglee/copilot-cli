/**
 * React hook subscribing to `skill_change_detector` and refreshing the active
 * `Command[]` list in `REPL.tsx` whenever `.copilot/skills` or `~/.copilot/skills`
 * changes on disk.
 */

import { useEffect } from 'react'
import { clearCommandsCache, getCommands } from '../commands.js'
import type { Command } from '../types/command.js'
import {
  disposeSkillChangeDetector,
  initializeSkillChangeDetector,
  onSkillsChanged,
} from '../utilities/skills/skill_change_detector.js'

/**
 * Watches skill directories for `cwd` and invokes `onCommandsChange` with the
 * refreshed command list whenever skills are added, modified, removed, or
 * conditionally activated.
 */
export function useSkillsChange(
  cwd: string,
  onCommandsChange: (commands: Command[]) => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    initializeSkillChangeDetector(cwd)
    const unsubscribe = onSkillsChanged(() => {
      clearCommandsCache()
      void getCommands(cwd).then(fresh => {
        onCommandsChange(fresh)
      })
    })
    return () => {
      unsubscribe()
      disposeSkillChangeDetector()
    }
  }, [cwd, enabled, onCommandsChange])
}

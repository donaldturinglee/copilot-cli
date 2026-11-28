/**
 * `chokidar`-backed hot reloader watching `~/.copilot/{skills,commands}` and
 * `<cwd>/.copilot/{skills,commands}` for live `.md` / `SKILL.md` additions,
 * edits, and deletions.
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { getAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js'
import {
  clearSkillCaches,
  onDynamicSkillsLoaded,
} from '../../skills/load_skills_dir.js'
import { registerCleanup } from '../cleanup_registry.js'
import { getCwd } from '../cwd.js'
import { getClaudeConfigHomeDir, isBareMode } from '../env_utils.js'
import { executeConfigChangeHooks } from '../hooks.js'
import { createSignal } from '../signal.js'

const RELOAD_DEBOUNCE_MS = 100

const skillsChangedSignal = createSignal<[]>()
let activeWatcher: FSWatcher | null = null
let watcherReadyPromise: Promise<void> = Promise.resolve()
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let dynamicUnsubscribe: (() => void) | null = null

/**
 * Subscribes to live skill directory changes and dynamic skill activations.
 */
export const onSkillsChanged = skillsChangedSignal.subscribe

function collectWatchPaths(cwd: string): string[] {
  const candidates = [
    join(getClaudeConfigHomeDir(), 'skills'),
    join(getClaudeConfigHomeDir(), 'commands'),
    join(resolve(cwd), '.copilot', 'skills'),
    join(resolve(cwd), '.copilot', 'commands'),
    ...getAdditionalDirectoriesForClaudeMd().map(dir =>
      join(resolve(dir), '.copilot', 'skills'),
    ),
  ]

  // Watch either the existing skills directory or its parent `.copilot` dir so
  // creating `.copilot/skills/demo/SKILL.md` mid-session is detected!
  const paths = new Set<string>()
  for (const dir of candidates) {
    if (existsSync(dir)) {
      paths.add(dir)
    } else {
      const parent = dirname(dir)
      if (existsSync(parent)) {
        paths.add(parent)
      }
    }
  }
  return Array.from(paths)
}

/**
 * Starts the `chokidar` skill file watcher for `cwd`.
 */
export function initializeSkillChangeDetector(cwd: string = getCwd()): void {
  if (isBareMode()) {
    return
  }
  disposeSkillChangeDetector()

  dynamicUnsubscribe = onDynamicSkillsLoaded(() => {
    skillsChangedSignal.emit()
  })

  const watchPaths = collectWatchPaths(cwd)
  if (watchPaths.length === 0) {
    return
  }

  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    depth: 3,
    ignorePermissionErrors: true,
    usePolling: false,
    ignored: (targetPath: string) =>
      targetPath.includes(`${join('.git', '')}`) ||
      targetPath.endsWith('/.git') ||
      targetPath.endsWith('\\.git'),
  })
  activeWatcher = watcher
  watcherReadyPromise = new Promise<void>(resolveReady => {
    watcher.once('ready', () => resolveReady())
    watcher.once('error', () => resolveReady())
  })

  const scheduleReload = (changedPath: string) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(async () => {
      debounceTimer = null
      const hookRes = await executeConfigChangeHooks({
        source: 'skills',
        filePath: changedPath,
      }).catch(() => null)
      if (hookRes && hookRes.blockingErrors.length > 0) {
        return
      }
      clearSkillCaches()
      skillsChangedSignal.emit()
    }, RELOAD_DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  activeWatcher.on('add', scheduleReload)
  activeWatcher.on('change', scheduleReload)
  activeWatcher.on('unlink', scheduleReload)
}

/**
 * Resolves once the active `chokidar` skill watcher has finished its initial
 * directory scan and is ready to emit live file events.
 */
export function waitForSkillChangeDetectorReady(): Promise<void> {
  return watcherReadyPromise
}

/**
 *Manually triggers a skill reload cycle (used when tests or commands write new
 * skill files and want deterministic immediate refresh without waiting for polling).
 */
export function notifySkillFilesChanged(): void {
  clearSkillCaches()
  skillsChangedSignal.emit()
}

/**
 * Stops the active `chokidar` skill watcher and clears pending debounce timers.
 */
export function disposeSkillChangeDetector(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (dynamicUnsubscribe) {
    dynamicUnsubscribe()
    dynamicUnsubscribe = null
  }
  if (activeWatcher) {
    const w = activeWatcher
    activeWatcher = null
    watcherReadyPromise = Promise.resolve()
    void w.close().catch(() => {})
  }
}

registerCleanup(async () => {
  if (activeWatcher) {
    const w = activeWatcher
    activeWatcher = null
    watcherReadyPromise = Promise.resolve()
    await w.close().catch(() => {})
  }
  disposeSkillChangeDetector()
})

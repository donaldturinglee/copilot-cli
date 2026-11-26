import type { FSWatcher } from 'chokidar'
import { watch } from 'chokidar'
import type { Stats } from 'fs'
import { dirname, normalize, sep } from 'path'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanup_registry.js'
import { logForDebugging } from '../debug.js'
import { getFsImplementation } from '../fs_operations.js'
import { createSignal } from '../signal.js'
import { jsonStringify } from '../slow_operations.js'
import { SETTING_SOURCES, type SettingSource } from './constants.js'
import { clearInternalWrites, consumeInternalWrite } from './internal_writes.js'
import { getManagedSettingsDropInDir } from './managed_path.js'
import {
  getHkcuSettings,
  getMdmSettings,
  refreshMdmSettings,
  setMdmSettingsCache,
} from './mdm/settings.js'
import { getSettingsFilePathForSource } from './settings.js'
import { resetSettingsCache } from './settings_cache.js'

const FILE_STABILITY_THRESHOLD_MS = 1000
const FILE_STABILITY_POLL_INTERVAL_MS = 500
const INTERNAL_WRITE_WINDOW_MS = 5000
const MDM_POLL_INTERVAL_MS = 30 * 60 * 1000
const DEFAULT_DELETION_GRACE_MS =
  FILE_STABILITY_THRESHOLD_MS + FILE_STABILITY_POLL_INTERVAL_MS + 200

export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'

export type ConfigChangeHookExecutor = (
  source: ConfigChangeSource,
  filePath: string,
) => Promise<Array<{ blocked?: boolean }>>

let configChangeHookExecutor: ConfigChangeHookExecutor | undefined

/**
 * Registers the Phase 4 ConfigChange hook executor so settings reloads can be
 * audited or blocked by configured hooks without backward imports.
 */
export function registerConfigChangeHookExecutor(
  executor: ConfigChangeHookExecutor | undefined,
): void {
  configChangeHookExecutor = executor
}

type TestTimingOverrides = {
  stabilityThresholdMs?: number
  pollIntervalMs?: number
  deletionGraceMs?: number
  internalWriteWindowMs?: number
  mdmPollIntervalMs?: number
}

let timingOverrides: TestTimingOverrides = {}
let watcher: FSWatcher | null = null
let mdmPollTimer: ReturnType<typeof setInterval> | null = null
let initialized = false
let disposed = false
let lastMdmSnapshot = ''
const pendingDeletions = new Map<string, ReturnType<typeof setTimeout>>()
const settingsChanged = createSignal<[source: SettingSource]>()

function toConfigChangeSource(
  source: SettingSource,
): ConfigChangeSource | null {
  switch (source) {
    case 'userSettings':
      return 'user_settings'
    case 'projectSettings':
      return 'project_settings'
    case 'localSettings':
      return 'local_settings'
    case 'policySettings':
      return 'policy_settings'
    case 'flagSettings':
      return null
  }
}

function fanOut(source: SettingSource): void {
  resetSettingsCache()
  settingsChanged.emit(source)
}

function resolveSourceForPath(filePath: string): SettingSource | null {
  const normalizedPath = normalize(filePath)
  const dropInDir = normalize(getManagedSettingsDropInDir())
  if (
    normalizedPath.startsWith(dropInDir + sep) &&
    normalizedPath.endsWith('.json')
  ) {
    return 'policySettings'
  }

  for (const source of SETTING_SOURCES) {
    if (source === 'flagSettings') continue
    const sourcePath = getSettingsFilePathForSource(source)
    if (sourcePath && normalize(sourcePath) === normalizedPath) {
      return source
    }
  }
  return null
}

async function isBlockedByHooks(
  source: SettingSource,
  filePath: string,
): Promise<boolean> {
  if (!configChangeHookExecutor) {
    return false
  }
  const hookSource = toConfigChangeSource(source)
  if (!hookSource) {
    return false
  }
  try {
    const results = await configChangeHookExecutor(hookSource, filePath)
    return results.some(result => result.blocked === true)
  } catch (error) {
    logForDebugging(`ConfigChange hook error: ${error}`, { level: 'warn' })
    return false
  }
}

async function handleChange(filePath: string): Promise<void> {
  const normalizedPath = normalize(filePath)
  const pendingTimer = pendingDeletions.get(normalizedPath)
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingDeletions.delete(normalizedPath)
  }

  const windowMs =
    timingOverrides.internalWriteWindowMs ?? INTERNAL_WRITE_WINDOW_MS
  if (consumeInternalWrite(normalizedPath, windowMs)) {
    return
  }

  const source = resolveSourceForPath(normalizedPath)
  if (!source) {
    return
  }

  if (await isBlockedByHooks(source, normalizedPath)) {
    return
  }

  fanOut(source)
}

async function handleAdd(filePath: string): Promise<void> {
  await handleChange(filePath)
}

function handleDelete(filePath: string): void {
  const normalizedPath = normalize(filePath)
  if (pendingDeletions.has(normalizedPath)) {
    return
  }

  const graceMs = timingOverrides.deletionGraceMs ?? DEFAULT_DELETION_GRACE_MS
  const timer = setTimeout(() => {
    pendingDeletions.delete(normalizedPath)
    void (async () => {
      const source = resolveSourceForPath(normalizedPath)
      if (!source) return
      if (await isBlockedByHooks(source, normalizedPath)) return
      fanOut(source)
    })()
  }, graceMs)
  timer.unref?.()
  pendingDeletions.set(normalizedPath, timer)
}

async function getWatchTargets(): Promise<{
  dirs: string[]
  settingsFiles: Set<string>
  dropInDir: string
}> {
  const fsImpl = getFsImplementation()
  const dirToPotentialFiles = new Map<string, string[]>()
  const existingDirs = new Set<string>()
  const settingsFiles = new Set<string>()

  for (const source of SETTING_SOURCES) {
    if (source === 'flagSettings') continue
    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) continue
    const normalizedFile = normalize(filePath)
    const dir = dirname(normalizedFile)
    const list = dirToPotentialFiles.get(dir) ?? []
    list.push(normalizedFile)
    dirToPotentialFiles.set(dir, list)

    try {
      await fsImpl.stat(normalizedFile)
      existingDirs.add(dir)
    } catch {
      // File does not exist yet
    }
  }

  for (const dir of existingDirs) {
    for (const candidate of dirToPotentialFiles.get(dir) ?? []) {
      settingsFiles.add(candidate)
    }
  }

  const dropInDir = normalize(getManagedSettingsDropInDir())
  try {
    const stats = await fsImpl.stat(dropInDir)
    if (stats.isDirectory()) {
      existingDirs.add(dropInDir)
    }
  } catch {
    // Drop-in directory absent
  }

  return {
    dirs: Array.from(existingDirs),
    settingsFiles,
    dropInDir,
  }
}

function startMdmPoll(): void {
  if (mdmPollTimer) return
  lastMdmSnapshot = jsonStringify({
    mdm: getMdmSettings().settings,
    hkcu: getHkcuSettings().settings,
  })
  const intervalMs = timingOverrides.mdmPollIntervalMs ?? MDM_POLL_INTERVAL_MS
  mdmPollTimer = setInterval(() => {
    void (async () => {
      try {
        const { mdm, hkcu } = await refreshMdmSettings()
        const snapshot = jsonStringify({
          mdm: mdm.settings,
          hkcu: hkcu.settings,
        })
        if (snapshot !== lastMdmSnapshot) {
          lastMdmSnapshot = snapshot
          setMdmSettingsCache(mdm, hkcu)
          fanOut('policySettings')
        }
      } catch (error) {
        logForDebugging(`MDM poll error: ${error}`, { level: 'warn' })
      }
    })()
  }, intervalMs)
  mdmPollTimer.unref?.()
}

export async function initialize(): Promise<void> {
  if (getIsRemoteMode() || initialized || disposed) {
    return
  }
  initialized = true
  startMdmPoll()
  registerCleanup(dispose)

  const { dirs, settingsFiles, dropInDir } = await getWatchTargets()
  if (disposed || dirs.length === 0) {
    return
  }

  const dropInPrefix = dropInDir + sep
  const stabilityThreshold =
    timingOverrides.stabilityThresholdMs ?? FILE_STABILITY_THRESHOLD_MS
  const pollInterval =
    timingOverrides.pollIntervalMs ?? FILE_STABILITY_POLL_INTERVAL_MS

  watcher = watch(dirs, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold,
      pollInterval,
    },
    ignored: (watchPath: string, stats?: Stats) => {
      if (stats && !stats.isFile() && !stats.isDirectory()) {
        return true
      }
      const normalized = normalize(watchPath)
      if (normalized.split(sep).includes('.git')) {
        return true
      }
      if (!stats || stats.isDirectory()) {
        return false
      }
      if (settingsFiles.has(normalized)) {
        return false
      }
      if (
        normalized.startsWith(dropInPrefix) &&
        normalized.endsWith('.json')
      ) {
        return false
      }
      return true
    },
    ignorePermissionErrors: true,
    usePolling: false,
    atomic: true,
  })

  watcher.on('change', filePath => {
    void handleChange(filePath)
  })
  watcher.on('add', filePath => {
    void handleAdd(filePath)
  })
  watcher.on('unlink', filePath => {
    handleDelete(filePath)
  })
  watcher.on('error', error => {
    logForDebugging(`Settings watcher error: ${error}`, { level: 'warn' })
  })
}

export async function dispose(): Promise<void> {
  disposed = true
  initialized = false
  if (mdmPollTimer) {
    clearInterval(mdmPollTimer)
    mdmPollTimer = null
  }
  for (const timer of pendingDeletions.values()) {
    clearTimeout(timer)
  }
  pendingDeletions.clear()
  if (watcher) {
    const activeWatcher = watcher
    watcher = null
    await activeWatcher.close()
  }
}

export const subscribe = settingsChanged.subscribe

export function notifyChange(source: SettingSource): void {
  fanOut(source)
}

export async function resetForTesting(
  overrides?: TestTimingOverrides,
): Promise<void> {
  await dispose()
  disposed = false
  settingsChanged.clear()
  clearInternalWrites()
  timingOverrides = overrides ?? {}
}

export const settingsChangeDetector = {
  initialize,
  dispose,
  subscribe,
  notifyChange,
  resetForTesting,
}

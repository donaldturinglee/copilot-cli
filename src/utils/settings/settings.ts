import mergeWith from 'lodash-es/mergeWith.js'
import uniq from 'lodash-es/uniq.js'
import { dirname, join, resolve } from 'path'
import {
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getUseCoworkPlugins,
} from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../env_utils.js'
import { isEnoent } from '../errors.js'
import { isFeatureEnabled } from '../feature_flags.js'
import { writeFileSyncAndFlushDeprecated } from '../file.js'
import { getFsImplementation } from '../fs_operations.js'
import { safeParseJson } from '../json.js'
import { logError } from '../log.js'
import { clone, jsonStringify } from '../slow_operations.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from './constants.js'
import { markInternalWrite } from './internal_writes.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from './managed_path.js'
import { getHkcuSettings, getMdmSettings } from './mdm/settings.js'
import {
  getCachedParsedFile,
  getCachedSettingsForSource,
  getPluginSettingsBase,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedParsedFile,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settings_cache.js'
import { type SettingsJson, SettingsSchema } from './types.js'
import {
  filterInvalidPermissionRules,
  formatZodError,
  type SettingsWithErrors,
  type ValidationError,
} from './validation.js'

export type SettingsWithSources = {
  effective: SettingsJson
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

export type PolicySettingsOrigin = 'remote' | 'plist' | 'hklm' | 'file' | 'hkcu'

let remoteManagedSettingsProvider:
  | (() => Record<string, unknown> | null)
  | undefined
let gitignoreRuleUpdater:
  | ((rule: string, repoRoot: string) => Promise<void>)
  | undefined

/**
 * Registers the Phase 11 remote managed settings cache provider.
 */
export function registerRemoteManagedSettingsProvider(
  provider: () => Record<string, unknown> | null,
): void {
  remoteManagedSettingsProvider = provider
}

/**
 * Registers the Phase 2 gitignore helper for auto-ignoring `.claude/settings.local.json`.
 */
export function registerGitignoreRuleUpdater(
  updater: (rule: string, repoRoot: string) => Promise<void>,
): void {
  gitignoreRuleUpdater = updater
}

let isLoadingSettings = false

/**
 * Lodash mergeWith customizer for read-time layered settings merging:
 * concatenates and deduplicates arrays while deep-merging plain objects.
 */
export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return uniq([...objValue, ...srcValue])
  }
  return undefined
}

function writeBackMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
  key: string,
  targetObject: Record<string, unknown>,
): unknown {
  if (srcValue === undefined && targetObject && typeof key === 'string') {
    delete targetObject[key]
    return undefined
  }
  if (Array.isArray(srcValue)) {
    return srcValue
  }
  void objValue
  return undefined
}

function parseSettingsFileUncached(filePath: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const fsImpl = getFsImplementation()
  let content: string
  try {
    content = fsImpl.readFileSync(filePath, { encoding: 'utf-8' })
  } catch (error) {
    if (isEnoent(error)) {
      return { settings: null, errors: [] }
    }
    return {
      settings: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: `Failed to read settings file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    }
  }

  if (content.trim() === '') {
    return { settings: {}, errors: [] }
  }

  const parsed = safeParseJson(content, false)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      settings: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: 'Invalid JSON syntax in settings file',
        },
      ],
    }
  }

  const workingCopy = clone(parsed) as Record<string, unknown>
  const ruleErrors = filterInvalidPermissionRules(workingCopy, filePath)
  const result = SettingsSchema().safeParse(workingCopy)

  if (!result.success) {
    return {
      settings: null,
      errors: [...ruleErrors, ...formatZodError(result.error, filePath)],
    }
  }

  return {
    settings: result.data,
    errors: ruleErrors,
  }
}

export function parseSettingsFile(filePath: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const cached = getCachedParsedFile(filePath)
  if (cached) {
    return {
      settings: cached.settings ? clone(cached.settings) : null,
      errors: [...cached.errors],
    }
  }

  const parsed = parseSettingsFileUncached(filePath)
  setCachedParsedFile(filePath, {
    settings: parsed.settings ? clone(parsed.settings) : null,
    errors: [...parsed.errors],
  })

  return {
    settings: parsed.settings ? clone(parsed.settings) : null,
    errors: parsed.errors,
  }
}

function getManagedDropInFiles(): string[] {
  const fsImpl = getFsImplementation()
  const dropInDir = getManagedSettingsDropInDir()
  try {
    const entries = fsImpl.readdirSync(dropInDir)
    return entries
      .filter(
        entry =>
          !entry.name.startsWith('.') &&
          entry.name.endsWith('.json') &&
          (entry.isFile() || entry.isSymbolicLink()),
      )
      .map(entry => entry.name)
      .sort()
      .map(name => join(dropInDir, name))
  } catch {
    return []
  }
}

export function getManagedFileSettingsPresence(): {
  hasBase: boolean
  hasDropIns: boolean
} {
  const fsImpl = getFsImplementation()
  const basePath = join(getManagedFilePath(), 'managed-settings.json')
  return {
    hasBase: fsImpl.existsSync(basePath),
    hasDropIns: getManagedDropInFiles().length > 0,
  }
}

export function loadManagedFileSettings(): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const basePath = join(getManagedFilePath(), 'managed-settings.json')
  const dropInPaths = getManagedDropInFiles()
  const allErrors: ValidationError[] = []
  let merged: SettingsJson | null = null

  const baseResult = parseSettingsFile(basePath)
  allErrors.push(...baseResult.errors)
  if (baseResult.settings) {
    merged = baseResult.settings
  }

  for (const dropInPath of dropInPaths) {
    const dropInResult = parseSettingsFile(dropInPath)
    allErrors.push(...dropInResult.errors)
    if (dropInResult.settings) {
      merged = merged
        ? mergeWith({}, merged, dropInResult.settings, settingsMergeCustomizer)
        : dropInResult.settings
    }
  }

  return { settings: merged, errors: allErrors }
}

export function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return resolve(getClaudeConfigHomeDir())
    case 'projectSettings':
    case 'localSettings':
      return resolve(getOriginalCwd())
    case 'flagSettings': {
      const flagPath = getFlagSettingsPath()
      return flagPath ? dirname(resolve(flagPath)) : resolve(getOriginalCwd())
    }
    case 'policySettings':
      return resolve(getManagedFilePath())
  }
}

export function getSettingsFilePathForSource(
  source: SettingSource,
): string | undefined {
  switch (source) {
    case 'userSettings': {
      const filename =
        getUseCoworkPlugins() ||
        isEnvTruthy(process.env.COPILOT_CLI_USE_COWORK_PLUGINS)
          ? 'cowork_settings.json'
          : 'settings.json'
      return join(resolve(getClaudeConfigHomeDir()), filename)
    }
    case 'projectSettings':
      return join(resolve(getOriginalCwd()), '.claude', 'settings.json')
    case 'localSettings':
      return join(resolve(getOriginalCwd()), '.claude', 'settings.local.json')
    case 'flagSettings': {
      const flagPath = getFlagSettingsPath()
      return flagPath ? resolve(flagPath) : undefined
    }
    case 'policySettings':
      return join(resolve(getManagedFilePath()), 'managed-settings.json')
  }
}

export function getRelativeSettingsFilePathForSource(
  source: 'projectSettings' | 'localSettings',
): string {
  return source === 'projectSettings'
    ? join('.claude', 'settings.json')
    : join('.claude', 'settings.local.json')
}

function hasKeys(value: Record<string, unknown> | null | undefined): boolean {
  return Boolean(value && Object.keys(value).length > 0)
}

function loadPolicySettings(): {
  settings: SettingsJson | null
  errors: ValidationError[]
  origin: PolicySettingsOrigin | null
} {
  const errors: ValidationError[] = []

  // 1. Remote managed settings (highest priority, first-source-wins)
  const remoteRaw = remoteManagedSettingsProvider?.() ?? null
  if (remoteRaw && hasKeys(remoteRaw)) {
    const workingCopy = clone(remoteRaw)
    const ruleErrors = filterInvalidPermissionRules(
      workingCopy,
      'remote-managed-settings',
    )
    const parsed = SettingsSchema().safeParse(workingCopy)
    if (parsed.success) {
      return {
        settings: parsed.data,
        errors: ruleErrors,
        origin: 'remote',
      }
    }
    errors.push(
      ...ruleErrors,
      ...formatZodError(parsed.error, 'remote-managed-settings'),
    )
  }

  // 2. Admin MDM (macOS plist / Windows HKLM)
  const mdm = getMdmSettings()
  if (hasKeys(mdm.settings) || mdm.errors.length > 0) {
    errors.push(...mdm.errors)
    if (hasKeys(mdm.settings)) {
      return {
        settings: clone(mdm.settings),
        errors,
        origin: process.platform === 'darwin' ? 'plist' : 'hklm',
      }
    }
  }

  // 3. Managed files (managed-settings.json + managed-settings.d/*.json)
  const managedFiles = loadManagedFileSettings()
  if (hasKeys(managedFiles.settings) || managedFiles.errors.length > 0) {
    errors.push(...managedFiles.errors)
    if (hasKeys(managedFiles.settings)) {
      return {
        settings: managedFiles.settings,
        errors,
        origin: 'file',
      }
    }
  }

  // 4. Windows HKCU (user-writable, lowest policy priority)
  const hkcu = getHkcuSettings()
  if (hasKeys(hkcu.settings) || hkcu.errors.length > 0) {
    errors.push(...hkcu.errors)
    if (hasKeys(hkcu.settings)) {
      return {
        settings: clone(hkcu.settings),
        errors,
        origin: 'hkcu',
      }
    }
  }

  return { settings: null, errors, origin: null }
}

function loadSettingsForSourceWithErrors(source: SettingSource): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  if (source === 'policySettings') {
    const policy = loadPolicySettings()
    return { settings: policy.settings, errors: policy.errors }
  }

  if (source === 'flagSettings') {
    const errors: ValidationError[] = []
    let merged: SettingsJson | null = null
    const flagPath = getSettingsFilePathForSource('flagSettings')
    if (flagPath) {
      const fileResult = parseSettingsFile(flagPath)
      errors.push(...fileResult.errors)
      if (fileResult.settings) {
        merged = fileResult.settings
      }
    }

    const inlineSettings = getFlagSettingsInline()
    if (inlineSettings) {
      const workingCopy = clone(inlineSettings)
      const ruleErrors = filterInvalidPermissionRules(
        workingCopy,
        'flagSettings(inline)',
      )
      errors.push(...ruleErrors)
      const parsed = SettingsSchema().safeParse(workingCopy)
      if (parsed.success) {
        merged = merged
          ? mergeWith({}, merged, parsed.data, settingsMergeCustomizer)
          : parsed.data
      } else {
        errors.push(...formatZodError(parsed.error, 'flagSettings(inline)'))
      }
    }

    return { settings: merged, errors }
  }

  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return { settings: null, errors: [] }
  }
  return parseSettingsFile(filePath)
}

function getSettingsForSourceUncached(
  source: SettingSource,
): SettingsJson | null {
  return loadSettingsForSourceWithErrors(source).settings
}

export function getSettingsForSource(
  source: SettingSource,
): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) {
    return cached
  }
  const loaded = getSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, loaded)
  return loaded
}

export function getPolicySettingsOrigin(): PolicySettingsOrigin | null {
  return loadPolicySettings().origin
}

/**
 * Safely updates a writable settings file (`userSettings`, `projectSettings`, `localSettings`).
 * - Refuses to overwrite files with invalid JSON syntax.
 * - Replaces arrays wholesale (instead of concatenating).
 * - Explicit `undefined` property values delete the key.
 * - Suppresses self-write watcher echo and resets all 3 cache tiers.
 */
export function updateSettingsForSource(
  source: EditableSettingSource | SettingSource,
  settings: SettingsJson,
): { error: Error | null } {
  if (source === 'policySettings' || source === 'flagSettings') {
    return { error: null }
  }

  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return { error: new Error(`No file path for setting source: ${source}`) }
  }

  const fsImpl = getFsImplementation()
  try {
    fsImpl.mkdirSync(dirname(filePath))

    let baseObject: Record<string, unknown>
    const existingSettings = getSettingsForSourceUncached(source)
    if (existingSettings !== null) {
      baseObject = clone(existingSettings) as Record<string, unknown>
    } else {
      try {
        const rawContent = fsImpl.readFileSync(filePath, { encoding: 'utf-8' })
        if (rawContent.trim() === '') {
          baseObject = {}
        } else {
          const parsedRaw = safeParseJson(rawContent, false)
          if (
            parsedRaw === null ||
            typeof parsedRaw !== 'object' ||
            Array.isArray(parsedRaw)
          ) {
            return {
              error: new Error(
                `Invalid JSON syntax in settings file at ${filePath}`,
              ),
            }
          }
          baseObject = clone(parsedRaw) as Record<string, unknown>
        }
      } catch (readError) {
        if (isEnoent(readError)) {
          baseObject = {}
        } else {
          return {
            error:
              readError instanceof Error
                ? readError
                : new Error(String(readError)),
          }
        }
      }
    }

    const updatedSettings = mergeWith(
      baseObject,
      settings,
      writeBackMergeCustomizer,
    )

    markInternalWrite(filePath)
    writeFileSyncAndFlushDeprecated(
      filePath,
      jsonStringify(updatedSettings, null, 2) + '\n',
      { encoding: 'utf-8' },
    )
    resetSettingsCache()

    if (source === 'localSettings' && gitignoreRuleUpdater) {
      void gitignoreRuleUpdater(
        join('.claude', 'settings.local.json'),
        getOriginalCwd(),
      ).catch(error => {
        logForDebugging(`Failed to update .gitignore: ${error}`)
      })
    }

    return { error: null }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    logError(err)
    return { error: err }
  }
}

function loadMergedSettings(): {
  effective: SettingsJson
  errors: ValidationError[]
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
} {
  if (isLoadingSettings) {
    return { effective: {}, errors: [], sources: [] }
  }

  isLoadingSettings = true
  try {
    let effective: SettingsJson = {}
    const pluginBase = getPluginSettingsBase()
    if (pluginBase) {
      const parsedBase = SettingsSchema().safeParse(clone(pluginBase))
      if (parsedBase.success) {
        effective = mergeWith({}, parsedBase.data, settingsMergeCustomizer)
      }
    }

    const enabledSources = getEnabledSettingSources()
    const seenFiles = new Set<string>()
    const seenErrors = new Set<string>()
    const allErrors: ValidationError[] = []
    const loadedSources: Array<{
      source: SettingSource
      settings: SettingsJson
    }> = []

    for (const source of enabledSources) {
      if (source !== 'policySettings' && source !== 'flagSettings') {
        const filePath = getSettingsFilePathForSource(source)
        if (filePath) {
          const resolved = resolve(filePath)
          if (seenFiles.has(resolved)) {
            continue
          }
          seenFiles.add(resolved)
        }
      }

      const result = loadSettingsForSourceWithErrors(source)
      setCachedSettingsForSource(source, result.settings)

      for (const err of result.errors) {
        const dedupKey = `${err.file ?? ''}:${err.path}:${err.message}`
        if (!seenErrors.has(dedupKey)) {
          seenErrors.add(dedupKey)
          allErrors.push(err)
        }
      }

      if (result.settings) {
        loadedSources.push({ source, settings: clone(result.settings) })
        effective = mergeWith(
          effective,
          result.settings,
          settingsMergeCustomizer,
        )
      }
    }

    return { effective, errors: allErrors, sources: loadedSources }
  } finally {
    isLoadingSettings = false
  }
}

export function getSettingsWithErrors(): SettingsWithErrors {
  const cached = getSessionSettingsCache()
  if (cached) {
    return cached
  }
  const { effective, errors } = loadMergedSettings()
  const result: SettingsWithErrors = { settings: effective, errors }
  setSessionSettingsCache(result)
  return result
}

export function getInitialSettings(): SettingsJson {
  return getSettingsWithErrors().settings
}

export const getSettingsDeprecated = getInitialSettings

export function getSettingsWithSources(): SettingsWithSources {
  resetSettingsCache()
  const { effective, errors, sources } = loadMergedSettings()
  setSessionSettingsCache({ settings: effective, errors })
  return { effective, sources }
}

const LOGGABLE_PERMISSION_KEYS = new Set([
  'allow',
  'deny',
  'ask',
  'defaultMode',
  'disableBypassPermissionsMode',
  'additionalDirectories',
])
const LOGGABLE_SANDBOX_KEYS = new Set([
  'enabled',
  'autoAllowBashIfSandboxed',
  'allowUnsandboxedCommands',
  'excludedCommands',
  'network',
  'filesystem',
])

export function getManagedSettingsKeysForLogging(
  settings: SettingsJson,
): string[] {
  const parsed = SettingsSchema().strip().safeParse(settings)
  if (!parsed.success) return []
  const keys: string[] = []
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue
    if (key === 'permissions' && value && typeof value === 'object') {
      for (const subKey of Object.keys(value as Record<string, unknown>)) {
        if (LOGGABLE_PERMISSION_KEYS.has(subKey)) {
          keys.push(`permissions.${subKey}`)
        }
      }
    } else if (key === 'sandbox' && value && typeof value === 'object') {
      for (const subKey of Object.keys(value as Record<string, unknown>)) {
        if (LOGGABLE_SANDBOX_KEYS.has(subKey)) {
          keys.push(`sandbox.${subKey}`)
        }
      }
    } else if (key === 'hooks' && value && typeof value === 'object') {
      for (const hookEvent of Object.keys(value as Record<string, unknown>)) {
        keys.push(`hooks.${hookEvent}`)
      }
    } else {
      keys.push(key)
    }
  }
  return keys.sort()
}

// ============================================================================
// Anti-RCE trusted-source-only security accessors (exclude projectSettings!)
// ============================================================================

const TRUSTED_SECURITY_SOURCES: readonly SettingSource[] = [
  'userSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

export function hasSkipDangerousModePermissionPrompt(): boolean {
  for (const source of TRUSTED_SECURITY_SOURCES) {
    if (getSettingsForSource(source)?.skipDangerousModePermissionPrompt) {
      return true
    }
  }
  return false
}

export function hasAutoModeOptIn(): boolean {
  if (!isFeatureEnabled('TRANSCRIPT_CLASSIFIER')) {
    return false
  }
  for (const source of TRUSTED_SECURITY_SOURCES) {
    if (getSettingsForSource(source)?.skipAutoPermissionPrompt) {
      return true
    }
  }
  return false
}

export function getUseAutoModeDuringPlan(): boolean {
  if (!isFeatureEnabled('TRANSCRIPT_CLASSIFIER')) {
    return true
  }
  for (const source of TRUSTED_SECURITY_SOURCES) {
    if (getSettingsForSource(source)?.useAutoModeDuringPlan === false) {
      return false
    }
  }
  return true
}

export function getAutoModeConfig():
  | { allow?: string[]; soft_deny?: string[]; environment?: string[] }
  | undefined {
  if (!isFeatureEnabled('TRANSCRIPT_CLASSIFIER')) {
    return undefined
  }
  const allow: string[] = []
  const softDeny: string[] = []
  const environment: string[] = []

  for (const source of TRUSTED_SECURITY_SOURCES) {
    const autoMode = getSettingsForSource(source)?.autoMode as
      | { allow?: string[]; soft_deny?: string[]; environment?: string[] }
      | undefined
    if (!autoMode) continue
    if (Array.isArray(autoMode.allow)) allow.push(...autoMode.allow)
    if (Array.isArray(autoMode.soft_deny)) softDeny.push(...autoMode.soft_deny)
    if (Array.isArray(autoMode.environment)) {
      environment.push(...autoMode.environment)
    }
  }

  if (allow.length === 0 && softDeny.length === 0 && environment.length === 0) {
    return undefined
  }

  return {
    ...(allow.length > 0 ? { allow: uniq(allow) } : {}),
    ...(softDeny.length > 0 ? { soft_deny: uniq(softDeny) } : {}),
    ...(environment.length > 0 ? { environment: uniq(environment) } : {}),
  }
}

/**
 * Checks whether any non-policy raw settings file contains a given top-level key
 * (bypassing schema validation).
 */
export function rawSettingsContainsKey(key: string): boolean {
  const fsImpl = getFsImplementation()
  for (const source of getEnabledSettingSources()) {
    if (source === 'policySettings') continue
    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) continue
    try {
      const content = fsImpl.readFileSync(filePath, { encoding: 'utf-8' })
      const parsed = safeParseJson(content, false)
      if (parsed && typeof parsed === 'object' && key in parsed) {
        return true
      }
    } catch {
      // Missing or unreadable file
    }
  }
  return false
}

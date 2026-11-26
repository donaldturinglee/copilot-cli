import { registerSettingsCacheResetter } from '../../bootstrap/state.js'
import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

type CachedParsedFile = {
  settings: SettingsJson | null
  errors: ValidationError[]
}

let sessionSettingsCache: SettingsWithErrors | null = null
const perSourceCache = new Map<SettingSource, SettingsJson | null>()
const parseFileCache = new Map<string, CachedParsedFile>()
let pluginSettingsBase: Record<string, unknown> | undefined

export function getSessionSettingsCache(): SettingsWithErrors | null {
  return sessionSettingsCache
}

export function setSessionSettingsCache(
  value: SettingsWithErrors | null,
): void {
  sessionSettingsCache = value
}

export function getCachedSettingsForSource(
  source: SettingSource,
): SettingsJson | null | undefined {
  return perSourceCache.get(source)
}

export function setCachedSettingsForSource(
  source: SettingSource,
  value: SettingsJson | null,
): void {
  perSourceCache.set(source, value)
}

export function getCachedParsedFile(
  filePath: string,
): CachedParsedFile | undefined {
  return parseFileCache.get(filePath)
}

export function setCachedParsedFile(
  filePath: string,
  value: CachedParsedFile,
): void {
  parseFileCache.set(filePath, value)
}

/**
 * Atomically clears all 3 settings cache tiers.
 * Does not clear pluginSettingsBase (persists across reloads until plugins change).
 */
export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parseFileCache.clear()
}

export function getPluginSettingsBase(): Record<string, unknown> | undefined {
  return pluginSettingsBase
}

export function setPluginSettingsBase(
  settings: Record<string, unknown> | undefined,
): void {
  pluginSettingsBase = settings
  resetSettingsCache()
}

export function clearPluginSettingsBase(): void {
  pluginSettingsBase = undefined
  resetSettingsCache()
}

registerSettingsCacheResetter(resetSettingsCache)

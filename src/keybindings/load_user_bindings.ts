import { watch, type FSWatcher } from 'chokidar'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../utilities/debug.js'
import { getClaudeConfigHomeDir } from '../utilities/env_utils.js'
import { DEFAULT_BINDINGS } from './default_bindings.js'
import { parseBindings } from './parser.js'
import { KeybindingConfigFileSchema } from './schema.js'
import type { ParsedBinding } from './types.js'
import {
  type KeybindingWarning,
  validateUserKeybindingBlocks,
} from './validate.js'

export type KeybindingsLoadResult = {
  bindings: ParsedBinding[]
  warnings: KeybindingWarning[]
}

type ChangeListener = (result: KeybindingsLoadResult) => void

let customPathOverride: string | null = null
let watcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<ChangeListener>()

export function getUserKeybindingsPath(): string {
  if (customPathOverride) return customPathOverride
  return join(getClaudeConfigHomeDir(), 'keybindings.json')
}

export function setUserKeybindingsPathForTesting(path: string | null): void {
  customPathOverride = path
}

/**
 * Load default bindings merged with user overrides from `~/.copilot/keybindings.json`.
 */
export function loadKeybindingsSyncWithWarnings(
  filePath: string = getUserKeybindingsPath(),
): KeybindingsLoadResult {
  const defaultParsed = parseBindings(DEFAULT_BINDINGS, 'default')
  const warnings: KeybindingWarning[] = []

  if (!existsSync(filePath)) {
    return { bindings: defaultParsed, warnings }
  }

  try {
    const raw = readFileSync(filePath, 'utf8')
    const json: unknown = JSON.parse(raw)
    const parsed = KeybindingConfigFileSchema.safeParse(json)

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        warnings.push({
          type: 'parse_error',
          severity: 'error',
          message: `keybindings.json ${issue.path.join('.') || 'root'}: ${issue.message}`,
        })
      }
      return { bindings: defaultParsed, warnings }
    }

    const userWarnings = validateUserKeybindingBlocks(parsed.data.bindings)
    warnings.push(...userWarnings)

    // Filter out non-rebindable error entries so hardcoded ctrl+c / ctrl+d stay intact
    const blockedKeys = new Set(
      userWarnings
        .filter(w => w.type === 'reserved_shortcut' && w.severity === 'error' && w.key)
        .map(w => `${w.context ?? ''}|${w.key}`),
    )

    const filteredBlocks = parsed.data.bindings.map(block => {
      const nextBindings: Record<string, string | null> = {}
      for (const [k, v] of Object.entries(block.bindings)) {
        if (blockedKeys.has(`${block.context}|${k}`)) continue
        nextBindings[k] = v
      }
      return { context: block.context, bindings: nextBindings }
    })

    const userParsed = parseBindings(filteredBlocks, 'user')
    return {
      bindings: [...defaultParsed, ...userParsed],
      warnings,
    }
  } catch (err) {
    warnings.push({
      type: 'parse_error',
      severity: 'error',
      message: `Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    })
    return { bindings: defaultParsed, warnings }
  }
}

export function reloadKeybindingsNow(
  filePath: string = getUserKeybindingsPath(),
): KeybindingsLoadResult {
  const result = loadKeybindingsSyncWithWarnings(filePath)
  for (const listener of [...listeners]) {
    listener(result)
  }
  return result
}

export async function initializeKeybindingWatcher(
  filePath: string = getUserKeybindingsPath(),
): Promise<void> {
  if (watcher) return

  const scheduleReload = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      const result = reloadKeybindingsNow(filePath)
      logForDebugging(
        `[keybindings] Hot-reloaded ${result.bindings.length} bindings (${result.warnings.length} warnings)`,
      )
    }, 50)
    if (typeof debounceTimer.unref === 'function') {
      debounceTimer.unref()
    }
  }

  watcher = watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  })
  watcher.on('add', scheduleReload)
  watcher.on('change', scheduleReload)
  watcher.on('unlink', scheduleReload)
}

export async function stopKeybindingWatcher(): Promise<void> {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    const active = watcher
    watcher = null
    await active.close()
  }
}

export function subscribeToKeybindingChanges(
  listener: ChangeListener,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

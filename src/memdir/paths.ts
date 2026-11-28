/**
 * Auto-memory path resolution and enablement (`src/memdir/paths.ts`):
 * - Resolves `~/.copilot/projects/<sanitized-canonical-git-root>/memory/` so
 *   linked git worktrees share one auto-memory directory
 * - Enforces anti-RCE exclusion of `projectSettings` for `autoMemoryDirectory`
 *   so untrusted repositories cannot redirect silent writes to sensitive dirs
 */

import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { isAbsolute, join, normalize, resolve, sep } from 'path'
import {
  getIsNonInteractiveSession,
  getIsRemoteMode,
  getProjectRoot,
} from '../bootstrap/state.js'
import { getFeatureValueCachedMayBeStale } from '../services/analytics/growthbook.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../utilities/env_utils.js'
import { findCanonicalGitRoot } from '../utilities/git.js'
import { sanitizePath } from '../utilities/path.js'
import type { SettingSource } from '../utilities/settings/constants.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../utilities/settings/settings.js'

export const AUTO_MEM_DIRNAME = 'memory'
export const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

// Security: `projectSettings` is intentionally excluded from `autoMemoryDirectory`
// so a malicious repo cannot redirect silent memory writes to e.g. `~/.ssh`.
const TRUSTED_MEMORY_DIR_SOURCES: readonly SettingSource[] = [
  'policySettings',
  'flagSettings',
  'localSettings',
  'userSettings',
]

/**
 * Returns whether automatic persistent memory (`memdir`) is enabled.
 */
export function isAutoMemoryEnabled(): boolean {
  const disableEnv =
    process.env.COPILOT_CLI_DISABLE_AUTO_MEMORY ??
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(disableEnv)) {
    return false
  }
  if (isEnvDefinedFalsy(disableEnv)) {
    return true
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_SIMPLE)) {
    return false
  }
  if (
    getIsRemoteMode() &&
    !process.env.COPILOT_CLI_REMOTE_MEMORY_DIR &&
    !process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  ) {
    return false
  }
  const setting = getInitialSettings().autoMemoryEnabled
  if (setting !== undefined) {
    return setting
  }
  return true
}

/**
 * Returns whether Stop-hook background memory extraction (`extractMemories`)
 * is active for the current session mode.
 */
export function isExtractModeActive(): boolean {
  if (!isAutoMemoryEnabled()) {
    return false
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_ENABLE_EXTRACT_MEMORIES)) {
    return true
  }
  const enabled = getFeatureValueCachedMayBeStale('tengu_passport_quail', false)
  if (!enabled) {
    return false
  }
  if (getIsNonInteractiveSession()) {
    return getFeatureValueCachedMayBeStale('tengu_slate_thimble', false)
  }
  return true
}

/**
 * Validates and normalizes an explicit auto-memory directory override,
 * rejecting relative paths, UNC shares, drive roots, null bytes, and trivial
 * tilde remainders.
 */
export function validateMemoryPath(
  raw: string,
  expandTilde: boolean,
): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('\0')) {
    return undefined
  }

  let candidate = trimmed
  if (expandTilde && (trimmed.startsWith('~/') || trimmed.startsWith('~\\'))) {
    const rest = trimmed.slice(2)
    const normRest = normalize(rest || '.')
    if (normRest === '.' || normRest === '..' || normRest.startsWith(`..${sep}`)) {
      return undefined
    }
    candidate = join(homedir(), rest)
  }

  const normalized = normalize(candidate).replace(/[\\/]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    return undefined
  }

  return `${normalized}${sep}`.normalize('NFC')
}

export function getMemoryBaseDir(): string {
  return (
    process.env.COPILOT_CLI_REMOTE_MEMORY_DIR ||
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR ||
    getClaudeConfigHomeDir()
  ).normalize('NFC')
}

export function getAutoMemBase(): string {
  const projectRoot = getProjectRoot()
  return findCanonicalGitRoot(projectRoot) ?? projectRoot
}

export function getAutoMemPathOverride(): string | undefined {
  const envOverride =
    process.env.COPILOT_CLI_MEMORY_PATH_OVERRIDE ??
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  if (envOverride) {
    const valid = validateMemoryPath(envOverride, false)
    if (valid) return valid
  }

  for (const source of TRUSTED_MEMORY_DIR_SOURCES) {
    const dir = getSettingsForSource(source)?.autoMemoryDirectory
    if (typeof dir === 'string' && dir.trim()) {
      const valid = validateMemoryPath(dir, true)
      if (valid) return valid
    }
  }

  return undefined
}

export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * Returns the canonical auto-memory directory path (trailing separator),
 * memoized by `getProjectRoot() + getMemoryBaseDir()`.
 */
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride()
    if (override) {
      return override
    }
    return (
      join(
        getMemoryBaseDir(),
        'projects',
        sanitizePath(getAutoMemBase()),
        AUTO_MEM_DIRNAME,
      ) + sep
    ).normalize('NFC')
  },
  () =>
    `${getProjectRoot()}::${getMemoryBaseDir()}::${getAutoMemPathOverride() ?? ''}`,
)

export function clearAutoMemPathCache(): void {
  getAutoMemPath.cache.clear?.()
}

export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * Returns `true` if `targetPath` resides inside the project's auto-memory
 * directory (cross-platform case-normalized on Windows).
 */
export function isAutoMemPath(targetPath: string): boolean {
  const normTarget = normalize(resolve(targetPath)).normalize('NFC')
  const normBase = normalize(getAutoMemPath()).normalize('NFC')
  if (process.platform === 'win32') {
    return (
      normTarget.toLowerCase() === normBase.replace(/[\\/]+$/, '').toLowerCase() ||
      normTarget.toLowerCase().startsWith(normBase.toLowerCase())
    )
  }
  return (
    normTarget === normBase.replace(/\/+$/, '') ||
    normTarget.startsWith(normBase)
  )
}

/**
 * OS-level command sandbox adapter wrapping `@anthropic-ai/sandbox-runtime`:
 * - macOS Seatbelt / Linux & WSL2 `bubblewrap + socat`
 * - Translates Copilot layered settings + permission rules into
 *   `SandboxRuntimeConfig` (`network.allowedDomains`/`deniedDomains`,
 *   `filesystem.allowWrite`/`denyWrite`/`denyRead`/`allowRead`)
 * - Protects all settings files across `SETTING_SOURCES`, `~/.copilot.json`,
 *   `.copilot/{skills,commands,agents}`, and bare git repository markers
 * - Bare-repo TOCTOU scrub: tracks non-existent `HEAD`/`objects`/`refs`/
 *   `hooks`/`config` paths before command execution and synchronously removes
 *   any newly planted files in `cleanupAfterCommand()` -> `scrubBareGitRepoFiles()`
 * - Integrates `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands`,
 *   `allowManagedDomainsOnly`, and policy locking
 */

import type { SandboxRuntimeConfig as RuntimeSandboxConfig } from '@anthropic-ai/sandbox-runtime'
import { existsSync, lstatSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import type {
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  SandboxViolationStoreLike,
} from '../../entrypoints/sandbox_types.js'

type SandboxRuntimeModule = typeof import('@anthropic-ai/sandbox-runtime')
type BaseSandboxManagerType = SandboxRuntimeModule['SandboxManager']

let cachedBaseSandboxManager: BaseSandboxManagerType | null = null

async function loadBaseSandboxManager(): Promise<BaseSandboxManagerType> {
  if (!cachedBaseSandboxManager) {
    const mod = await import('@anthropic-ai/sandbox-runtime')
    cachedBaseSandboxManager = mod.SandboxManager
  }
  return cachedBaseSandboxManager
}

const EMPTY_VIOLATION_STORE: SandboxViolationStoreLike = {
  getViolations: () => [],
  getTotalCount: () => 0,
  getViolationsForCommand: () => [],
  clear: () => {},
}
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { getGlobalClaudeFile } from '../env.js'
import { getClaudeConfigHomeDir } from '../env_utils.js'
import { isCurrentDirectoryBareGitRepo } from '../git.js'
import { expandPath } from '../path.js'
import { getCopilotTempDir } from '../permissions/filesystem.js'
import { permissionRuleValueFromString } from '../permissions/permission_rule_parser.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { getManagedFilePath } from '../settings/managed_path.js'
import * as settingsModule from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'

const BARE_GIT_REPO_MARKERS = ['HEAD', 'objects', 'refs', 'hooks', 'config'] as const

const PROTECTED_COPILOT_SUBDIRS = ['skills', 'commands', 'agents'] as const

export interface SandboxTestRuntimeOverride {
  enabled: boolean
  supportedPlatform?: boolean
  proxyPort?: number
  socksProxyPort?: number
  wrapWithSandbox?: (
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
  ) => Promise<string>
  onCleanupAfterCommand?: () => void
}

let initialized = false
let testOverride: SandboxTestRuntimeOverride | null = null
let activeRuntimeConfig: SandboxRuntimeConfig | undefined
let bareGitRepoScrubPaths: string[] = []
let lastScrubbedPaths: string[] = []

/**
 * Installs a deterministic test override for sandbox execution on platforms
 * where kernel sandboxing is unavailable (e.g. Windows CI/dev hosts).
 */
export function setSandboxTestRuntimeForTesting(
  override: SandboxTestRuntimeOverride | null,
): void {
  testOverride = override
}

export function getBareGitRepoScrubPathsForTesting(): readonly string[] {
  return bareGitRepoScrubPaths
}

export function getLastScrubbedPathsForTesting(): readonly string[] {
  return lastScrubbedPaths
}

function dedupeStrings(items: readonly string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

function extractDomainRulesFromSettings(
  rules: readonly string[] | undefined,
): string[] {
  if (!rules?.length) return []
  const domains: string[] = []
  for (const raw of rules) {
    const parsed = permissionRuleValueFromString(raw)
    if (parsed.toolName === 'WebFetch' && parsed.ruleContent) {
      const m = parsed.ruleContent.match(/^domain:(.+)$/i)
      if (m?.[1]?.trim()) {
        domains.push(m[1].trim())
      }
    }
  }
  return domains
}

function extractPathRulesFromSettings(
  rules: readonly string[] | undefined,
  toolNames: ReadonlySet<string>,
): string[] {
  if (!rules?.length) return []
  const paths: string[] = []
  for (const raw of rules) {
    const parsed = permissionRuleValueFromString(raw)
    if (toolNames.has(parsed.toolName) && parsed.ruleContent) {
      const cleaned = parsed.ruleContent.replace(/^\/\//, '/')
      paths.push(cleaned)
    }
  }
  return paths
}

/**
 * Translates Copilot CLI layered settings and permission rules into a strict
 * `@anthropic-ai/sandbox-runtime` `SandboxRuntimeConfig`, protecting all
 * settings files, `.copilot/{skills,commands,agents}`, and bare-repo markers.
 */
export function convertToSandboxRuntimeConfig(
  settings: SettingsJson = settingsModule.getSettings(),
  cwd: string = getCwd(),
): SandboxRuntimeConfig {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  const allowManagedDomainsOnly =
    (policySettings?.sandbox?.network as Record<string, unknown> | undefined)
      ?.allowManagedDomainsOnly === true

  // 1. Network domain allowlist / denylist
  const policyNetworkDomains =
    policySettings?.sandbox?.network?.allowedDomains ?? []
  const mergedNetworkDomains = settings.sandbox?.network?.allowedDomains ?? []
  const webFetchAllowedDomains = extractDomainRulesFromSettings(
    settings.permissions?.allow,
  )
  const webFetchDeniedDomains = extractDomainRulesFromSettings(
    settings.permissions?.deny,
  )
  const policyDeniedDomains =
    ((policySettings?.sandbox?.network as Record<string, unknown> | undefined)
      ?.deniedDomains as string[] | undefined) ?? []
  const mergedDeniedDomains =
    ((settings.sandbox?.network as Record<string, unknown> | undefined)
      ?.deniedDomains as string[] | undefined) ?? []

  const allowedDomains = allowManagedDomainsOnly
    ? dedupeStrings([
        ...policyNetworkDomains,
        ...extractDomainRulesFromSettings(policySettings?.permissions?.allow),
      ])
    : dedupeStrings([...mergedNetworkDomains, ...webFetchAllowedDomains])

  const deniedDomains = dedupeStrings([
    ...policyDeniedDomains,
    ...mergedDeniedDomains,
    ...webFetchDeniedDomains,
  ])

  // 2. Filesystem allowWrite / denyWrite / denyRead / allowRead
  const editTools = new Set(['Edit', 'Write', 'FileEdit', 'FileWrite'])
  const readTools = new Set(['Read', 'FileRead'])

  const additionalDirs = (settings.permissions?.additionalDirectories ?? []).map(
    d => expandPath(d),
  )

  const allowWrite = dedupeStrings([
    '.',
    resolve(cwd),
    getCopilotTempDir(),
    ...additionalDirs,
    ...extractPathRulesFromSettings(settings.permissions?.allow, editTools),
    ...(settings.sandbox?.filesystem?.allowWrite ?? []),
  ])

  // Always protect ALL settings files across all tiers + `~/.copilot.json` +
  // `.copilot/{skills,commands,agents}` against sandboxed writes!
  const mandatoryDenyWrite: string[] = [
    getManagedFilePath(),
    getGlobalClaudeFile(),
    join(getClaudeConfigHomeDir(), 'settings.json'),
    join(cwd, '.copilot', 'settings.json'),
    join(cwd, '.copilot', 'settings.local.json'),
  ]

  for (const source of SETTING_SOURCES) {
    const filePath = settingsModule.getSettingsFilePathForSource(source)
    if (filePath) {
      mandatoryDenyWrite.push(filePath)
    }
  }

  for (const subdir of PROTECTED_COPILOT_SUBDIRS) {
    mandatoryDenyWrite.push(join(cwd, '.copilot', subdir))
    mandatoryDenyWrite.push(join(getClaudeConfigHomeDir(), subdir))
  }

  // Bare git repo escape defense:
  // - If cwd already has `.git` or is NOT a git repo, existing bare-repo markers
  //   are added to `denyWrite`, and non-existent markers are recorded in
  //   `bareGitRepoScrubPaths` for synchronous post-command scrubbing!
  const nextScrubPaths: string[] = []
  const isBareNow = isCurrentDirectoryBareGitRepo(cwd)
  const hasDotGit = existsSync(join(cwd, '.git'))

  for (const marker of BARE_GIT_REPO_MARKERS) {
    const markerPath = join(cwd, marker)
    if (existsSync(markerPath)) {
      if (isBareNow || marker === 'hooks' || marker === 'config') {
        mandatoryDenyWrite.push(markerPath)
      }
    } else if (!hasDotGit) {
      nextScrubPaths.push(markerPath)
    }
  }
  // Protect `.git/hooks` and `.git/config` directly when `.git` exists
  if (hasDotGit) {
    mandatoryDenyWrite.push(join(cwd, '.git', 'hooks'))
    mandatoryDenyWrite.push(join(cwd, '.git', 'config'))
  }
  bareGitRepoScrubPaths = nextScrubPaths

  const denyWrite = dedupeStrings([
    ...mandatoryDenyWrite,
    ...extractPathRulesFromSettings(settings.permissions?.deny, editTools),
    ...(settings.sandbox?.filesystem?.denyWrite ?? []),
  ])

  const denyRead = dedupeStrings([
    ...extractPathRulesFromSettings(settings.permissions?.deny, readTools),
    ...(settings.sandbox?.filesystem?.denyRead ?? []),
  ])

  const allowRead = dedupeStrings([
    ...extractPathRulesFromSettings(settings.permissions?.allow, readTools),
    ...(((settings.sandbox?.filesystem as Record<string, unknown> | undefined)
      ?.allowRead as string[] | undefined) ?? []),
  ])

  return {
    network: {
      allowedDomains,
      deniedDomains,
      ...(settings.sandbox?.network?.allowUnixSockets
        ? { allowUnixSockets: [...settings.sandbox.network.allowUnixSockets] }
        : {}),
      ...(settings.sandbox?.network?.allowAllUnixSockets !== undefined
        ? { allowAllUnixSockets: settings.sandbox.network.allowAllUnixSockets }
        : {}),
      ...(settings.sandbox?.network?.allowLocalBinding !== undefined
        ? { allowLocalBinding: settings.sandbox.network.allowLocalBinding }
        : {}),
      ...(settings.sandbox?.network?.httpProxyPort !== undefined
        ? { httpProxyPort: settings.sandbox.network.httpProxyPort }
        : {}),
      ...(settings.sandbox?.network?.socksProxyPort !== undefined
        ? { socksProxyPort: settings.sandbox.network.socksProxyPort }
        : {}),
    },
    filesystem: {
      denyRead,
      ...(allowRead.length > 0 ? { allowRead } : {}),
      allowWrite,
      denyWrite,
    },
  }
}

/**
 * Synchronously removes any bare-repository marker files (`HEAD`, `objects`,
 * `refs`, `hooks`, `config`) that did not exist before the sandboxed command
 * started, neutralizing bare-repo planting escapes before the next `git` call.
 */
export function scrubBareGitRepoFiles(
  paths: readonly string[] = bareGitRepoScrubPaths,
): string[] {
  const removed: string[] = []
  for (const target of paths) {
    try {
      // lstatSync detects symlinks too (even dangling symlinks)
      lstatSync(target)
      rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 25,
      })
      removed.push(target)
      logForDebugging(`Sandbox bare-repo scrub removed newly planted path: ${target}`, {
        level: 'warn',
      })
    } catch {
      // Path was not created (normal case)
    }
  }
  lastScrubbedPaths = removed
  return removed
}

function isSandboxEnabledInSettings(): boolean {
  const policy = settingsModule.getSettingsForSource('policySettings')
  if (policy?.sandbox?.enabled !== undefined) {
    return policy.sandbox.enabled
  }
  return settingsModule.getSettings().sandbox?.enabled === true
}

function isSandboxSupportedOnHost(): boolean {
  if (testOverride?.supportedPlatform !== undefined) {
    return testOverride.supportedPlatform
  }
  if (cachedBaseSandboxManager) {
    try {
      return cachedBaseSandboxManager.isSupportedPlatform()
    } catch {
      return false
    }
  }
  return process.platform === 'darwin' || process.platform === 'linux'
}

export const SandboxManager = {
  isSupportedPlatform(): boolean {
    return isSandboxSupportedOnHost()
  },

  checkDependencies(): SandboxDependencyCheck {
    if (testOverride) {
      return { errors: [], warnings: [] }
    }
    if (!cachedBaseSandboxManager) {
      if (!isSandboxSupportedOnHost()) {
        return {
          errors: [`Unsupported platform: ${process.platform}`],
          warnings: [],
        }
      }
      return { errors: [], warnings: [] }
    }
    try {
      return cachedBaseSandboxManager.checkDependencies()
    } catch (error) {
      return {
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
      }
    }
  },

  getSandboxUnavailableReason(): string | null {
    if (!isSandboxSupportedOnHost()) {
      return `OS sandboxing is not supported on platform '${process.platform}'`
    }
    const deps = this.checkDependencies()
    if (deps.errors.length > 0) {
      return `Missing sandbox dependencies: ${deps.errors.join('; ')}`
    }
    return null
  },

  areSandboxSettingsLockedByPolicy(): boolean {
    const policy = settingsModule.getSettingsForSource('policySettings')
    return policy?.sandbox?.enabled !== undefined
  },

  isSandboxRequired(): boolean {
    const policy = settingsModule.getSettingsForSource('policySettings')
    return (
      policy?.sandbox?.enabled === true &&
      policy.sandbox.allowUnsandboxedCommands === false
    )
  },

  isSandboxingEnabled(): boolean {
    if (testOverride) {
      return testOverride.enabled
    }
    if (!isSandboxEnabledInSettings()) {
      return false
    }
    if (!isSandboxSupportedOnHost()) {
      return false
    }
    return true
  },

  isAutoAllowBashIfSandboxedEnabled(): boolean {
    if (!this.isSandboxingEnabled()) {
      return false
    }
    const settings = settingsModule.getSettings()
    return settings.sandbox?.autoAllowBashIfSandboxed !== false
  },

  areUnsandboxedCommandsAllowed(): boolean {
    const policy = settingsModule.getSettingsForSource('policySettings')
    if (policy?.sandbox?.allowUnsandboxedCommands === false) {
      return false
    }
    const settings = settingsModule.getSettings()
    return settings.sandbox?.allowUnsandboxedCommands !== false
  },

  getExcludedCommands(): string[] {
    return [...(settingsModule.getSettings().sandbox?.excludedCommands ?? [])]
  },

  getConfig(): SandboxRuntimeConfig | undefined {
    return activeRuntimeConfig
  },

  async initialize(
    sandboxAskCallback?: SandboxAskCallback,
    enableLogMonitor = false,
  ): Promise<void> {
    activeRuntimeConfig = convertToSandboxRuntimeConfig()
    if (testOverride) {
      initialized = true
      return
    }
    if (!this.isSandboxingEnabled()) {
      return
    }
    const baseMgr = await loadBaseSandboxManager()
    await baseMgr.initialize(
      activeRuntimeConfig as RuntimeSandboxConfig,
      sandboxAskCallback as Parameters<BaseSandboxManagerType['initialize']>[1],
      enableLogMonitor,
    )
    initialized = true
  },

  async refreshConfig(): Promise<SandboxRuntimeConfig> {
    activeRuntimeConfig = convertToSandboxRuntimeConfig()
    if (initialized && !testOverride && this.isSandboxingEnabled()) {
      try {
        const baseMgr = await loadBaseSandboxManager()
        baseMgr.updateConfig(activeRuntimeConfig as RuntimeSandboxConfig)
      } catch (error) {
        logForDebugging(
          `Sandbox refreshConfig warning: ${error instanceof Error ? error.message : String(error)}`,
          { level: 'warn' },
        )
      }
    }
    return activeRuntimeConfig
  },

  async waitForNetworkInitialization(): Promise<boolean> {
    if (testOverride) {
      return testOverride.enabled
    }
    if (!this.isSandboxingEnabled()) {
      return false
    }
    try {
      const baseMgr = await loadBaseSandboxManager()
      return await baseMgr.waitForNetworkInitialization()
    } catch {
      return false
    }
  },

  getProxyPort(): number | undefined {
    if (testOverride) {
      return testOverride.proxyPort
    }
    if (!this.isSandboxingEnabled() || !cachedBaseSandboxManager) return undefined
    try {
      return cachedBaseSandboxManager.getProxyPort()
    } catch {
      return undefined
    }
  },

  getSocksProxyPort(): number | undefined {
    if (testOverride) {
      return testOverride.socksProxyPort
    }
    if (!this.isSandboxingEnabled() || !cachedBaseSandboxManager) return undefined
    try {
      return cachedBaseSandboxManager.getSocksProxyPort()
    } catch {
      return undefined
    }
  },

  async wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    // Refresh bare-repo scrub tracking prior to command launch
    activeRuntimeConfig = convertToSandboxRuntimeConfig()

    if (testOverride?.wrapWithSandbox) {
      return testOverride.wrapWithSandbox(command, binShell, customConfig)
    }

    if (!this.isSandboxingEnabled()) {
      return command
    }

    if (!initialized) {
      await this.initialize()
    }

    const baseMgr = await loadBaseSandboxManager()
    return baseMgr.wrapWithSandbox(
      command,
      binShell,
      customConfig as Partial<RuntimeSandboxConfig> | undefined,
      abortSignal,
    )
  },

  /**
   * Synchronous post-command cleanup:
   * 1. Scrubs any newly planted bare-repo marker files in cwd.
   * 2. Releases any per-command sandbox runtime resources.
   */
  cleanupAfterCommand(): void {
    scrubBareGitRepoFiles()
    if (testOverride?.onCleanupAfterCommand) {
      testOverride.onCleanupAfterCommand()
    }
    if (!testOverride && initialized && cachedBaseSandboxManager) {
      try {
        cachedBaseSandboxManager.cleanupAfterCommand()
      } catch {
        // Ignore cleanup errors when runtime was not initialized
      }
    }
  },

  annotateStderrWithSandboxFailures(command: string, stderr: string): string {
    if (testOverride || !initialized || !cachedBaseSandboxManager) {
      return stderr
    }
    try {
      return cachedBaseSandboxManager.annotateStderrWithSandboxFailures(
        command,
        stderr,
      )
    } catch {
      return stderr
    }
  },

  getSandboxViolationStore(): SandboxViolationStoreLike {
    if (!cachedBaseSandboxManager) {
      return EMPTY_VIOLATION_STORE
    }
    return cachedBaseSandboxManager.getSandboxViolationStore()
  },

  async reset(): Promise<void> {
    initialized = false
    activeRuntimeConfig = undefined
    bareGitRepoScrubPaths = []
    lastScrubbedPaths = []
    testOverride = null
    if (cachedBaseSandboxManager) {
      try {
        await cachedBaseSandboxManager.reset()
      } catch {
        // Ignore reset errors if runtime was never started
      }
    }
  },
}

import { randomBytes } from 'crypto'
import { unwatchFile, watchFile } from 'fs'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import type {
  BillingType,
  ImageDimensions,
  McpServerConfig,
  MemoryType,
  ModelOption,
  ReferralEligibilityResponse,
  StoredCompanion,
  ThemeSetting,
} from '../types/forward.js'
import { registerCleanup } from './cleanup_registry.js'
import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from './config_constants.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPii } from './diag_logs.js'
import { getGlobalClaudeFile } from './env.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './env_utils.js'
import { ConfigParseError, getErrnoCode } from './errors.js'
import { isFeatureEnabled } from './feature_flags.js'
import { writeFileSyncAndFlushDeprecated } from './file.js'
import { getFsImplementation } from './fs_operations.js'
import { safeParseJson } from './json.js'
import { stripBom } from './json_read.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { normalizePathForConfigKey } from './path.js'
import { getManagedFilePath } from './settings/managed_path.js'
import { jsonParse, jsonStringify } from './slow_operations.js'

export { EDITOR_MODES, NOTIFICATION_CHANNELS } from './config_constants.js'

const MIN_BACKUP_INTERVAL_MS = 60_000
const MAX_BACKUPS = 5
const CONFIG_FRESHNESS_POLL_MS = 1000
export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

let insideGetConfig = false
let trustAccepted = false
let useDiskConfigInTests = false
let gitRootFinder: ((directory: string) => string | null) | undefined
let autoMemEntrypointProvider: (() => string) | undefined
let teamMemEntrypointProvider: (() => string) | undefined

export function registerConfigGitRootFinder(
  finder: (directory: string) => string | null,
): void {
  gitRootFinder = finder
  getProjectPathForConfig.cache.clear?.()
}

export function registerMemoryPathProviders(providers: {
  getAutoMemEntrypoint?: () => string
  getTeamMemEntrypoint?: () => string
}): void {
  if (providers.getAutoMemEntrypoint) {
    autoMemEntrypointProvider = providers.getAutoMemEntrypoint
  }
  if (providers.getTeamMemEntrypoint) {
    teamMemEntrypointProvider = providers.getTeamMemEntrypoint
  }
}

export type PastedContent = {
  id: number
  type: 'text' | 'image'
  content: string
  mediaType?: string
  filename?: string
  dimensions?: ImageDimensions
  sourcePath?: string
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}

export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  disabledMcpServers?: string[]
  enabledMcpServers?: string[]
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]
export type DiffTool = 'terminal' | 'auto'
export type OutputStyle = string

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null
  organizationRole?: string | null
  workspaceRole?: string | null
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

export type GlobalConfig = {
  apiKeyHelper?: string
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  autoUpdatesProtectedForNative?: boolean
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  lastOnboardingVersion?: string
  lastReleaseNotesSeen?: string
  changelogLastFetched?: number
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  customNotifyCommand?: string
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string
  hasAcknowledgedCostThreshold?: boolean
  hasSeenUndercoverAutoNotice?: boolean
  hasSeenUltraplanTerms?: boolean
  hasResetAutoModeOptInForDefaultOffer?: boolean
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean
  showTurnDuration: boolean
  env: { [key: string]: string }
  hasSeenTasksHint?: boolean
  hasUsedStash?: boolean
  hasUsedBackgroundTask?: boolean
  queuedCommandUpHintCount?: number
  diffTool?: DiffTool
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string
  appleTerminalBackupPath?: string
  appleTerminalSetupInProgress?: boolean
  shiftEnterKeyBindingInstalled?: boolean
  optionAsMetaKeyInstalled?: boolean
  autoConnectIde?: boolean
  autoInstallIdeExtension?: boolean
  hasIdeOnboardingBeenShown?: Record<string, boolean>
  ideHintShownCount?: number
  hasIdeAutoConnectDialogBeenShown?: boolean
  tipsHistory: {
    [tipId: string]: number
  }
  companion?: StoredCompanion
  companionMuted?: boolean
  feedbackSurveyState?: {
    lastShownTime?: number
  }
  transcriptShareDismissed?: boolean
  memoryUsageCount: number
  hasShownS1MWelcomeV2?: Record<string, boolean>
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  passesEligibilityCache?: Record<
    string,
    ReferralEligibilityResponse & { timestamp: number }
  >
  groveConfigCache?: Record<
    string,
    { grove_enabled: boolean; timestamp: number }
  >
  passesUpsellSeenCount?: number
  hasVisitedPasses?: boolean
  passesLastSeenRemaining?: number
  overageCreditGrantCache?: Record<
    string,
    {
      info: {
        available: boolean
        eligible: boolean
        granted: boolean
        amount_minor_units: number | null
        currency: string | null
      }
      timestamp: number
    }
  >
  overageCreditUpsellSeenCount?: number
  hasVisitedExtraUsage?: boolean
  voiceNoticeSeenCount?: number
  voiceLangHintShownCount?: number
  voiceLangHintLastLanguage?: string
  voiceFooterHintSeenCount?: number
  opus1mMergeNoticeSeenCount?: number
  experimentNoticesSeenCount?: Record<string, number>
  hasShownOpusPlanWelcome?: Record<string, boolean>
  promptQueueUseCount: number
  btwUseCount: number
  lastPlanModeUse?: number
  subscriptionNoticeCount?: number
  hasAvailableSubscription?: boolean
  subscriptionUpsellShownCount?: number
  recommendedSubscription?: string
  todoFeatureEnabled: boolean
  showExpandedTodos?: boolean
  showSpinnerTree?: boolean
  firstStartTime?: string
  messageIdleNotifThresholdMs: number
  githubActionSetupCount?: number
  slackAppInstallCount?: number
  fileCheckpointingEnabled: boolean
  terminalProgressBarEnabled: boolean
  showStatusInTerminalTab?: boolean
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean
  claudeCodeFirstTokenDate?: string
  modelSwitchCalloutDismissed?: boolean
  modelSwitchCalloutLastShown?: number
  modelSwitchCalloutVersion?: string
  effortCalloutDismissed?: boolean
  effortCalloutV2Dismissed?: boolean
  remoteDialogSeen?: boolean
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number
  desktopUpsellSeenCount?: number
  desktopUpsellDismissed?: boolean
  idleReturnDismissed?: boolean
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number
  sonnet1m45MigrationComplete?: boolean
  legacyOpusMigrationTimestamp?: number
  sonnet45To46MigrationTimestamp?: number
  cachedStatsigGates: {
    [gateName: string]: boolean
  }
  cachedDynamicConfigs?: { [configName: string]: unknown }
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }
  growthBookOverrides?: { [featureName: string]: unknown }
  lastShownEmergencyTip?: string
  respectGitignore: boolean
  copyFullResponse: boolean
  copyOnSelect?: boolean
  githubRepoPaths?: Record<string, string[]>
  deepLinkTerminal?: string
  iterm2It2SetupComplete?: boolean
  preferTmuxOverIterm2?: boolean
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  officialMarketplaceAutoInstallAttempted?: boolean
  officialMarketplaceAutoInstalled?: boolean
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown'
  officialMarketplaceAutoInstallRetryCount?: number
  officialMarketplaceAutoInstallLastAttemptTime?: number
  officialMarketplaceAutoInstallNextRetryTime?: number
  hasCompletedClaudeInChromeOnboarding?: boolean
  claudeInChromeDefaultEnabled?: boolean
  cachedChromeExtensionInstalled?: boolean
  chromeExtension?: {
    pairedDeviceId?: string
    pairedDeviceName?: string
  }
  lspRecommendationDisabled?: boolean
  lspRecommendationNeverPlugins?: string[]
  lspRecommendationIgnoredCount?: number
  claudeCodeHints?: {
    plugin?: string[]
    disabled?: boolean
  }
  permissionExplainerEnabled?: boolean
  teammateMode?: 'auto' | 'tmux' | 'in-process'
  teammateDefaultModel?: string | null
  prStatusFooterEnabled?: boolean
  tungstenPanelVisible?: boolean
  penguinModeOrgEnabled?: boolean
  startupPrefetchedAt?: number
  remoteControlAtStartup?: boolean
  cachedExtraUsageDisabledReason?: string | null
  autoPermissionsNotificationCount?: number
  speculationEnabled?: boolean
  clientDataCache?: Record<string, unknown> | null
  additionalModelOptionsCache?: ModelOption[]
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }
  migrationVersion?: number
}

function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'autoCompactEnabled',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

export function resetTrustDialogAcceptedCacheForTesting(): void {
  trustAccepted = false
}

function shouldUseInMemoryTestConfig(): boolean {
  return process.env.NODE_ENV === 'test' && !useDiskConfigInTests
}

let testGlobalConfig: GlobalConfig = {
  ...createDefaultGlobalConfig(),
  autoUpdates: false,
}
let testProjectConfig: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function setUseDiskConfigInTestsForTesting(enabled: boolean): void {
  useDiskConfigInTests = enabled
  globalConfigCache = { config: null, mtime: 0 }
  lastReadFileStats = null
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
}

export function resetTestConfigForTesting(): void {
  testGlobalConfig = {
    ...createDefaultGlobalConfig(),
    autoUpdates: false,
  }
  testProjectConfig = {
    ...DEFAULT_PROJECT_CONFIG,
  }
  globalConfigCache = { config: null, mtime: 0 }
  lastReadFileStats = null
  trustAccepted = false
  configReadingAllowed = false
  getGlobalClaudeFile.cache.clear?.()
  getProjectPathForConfig.cache.clear?.()
}

export function checkHasTrustDialogAccepted(): boolean {
  return (trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  let currentPath = normalizePathForConfigKey(getCwd())
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}
let lastReadFileStats: { mtime: number; size: number } | null = null
let configCacheHits = 0
let configCacheMisses = 0
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('tengu_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  configCacheHits = 0
  configCacheMisses = 0
}

registerCleanup(async () => {
  reportConfigCacheStats()
})

function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  if (config.installMethod !== undefined) {
    return config
  }

  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      installMethod = 'global'
      break
    case undefined:
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [projectPath, projectConfig] of Object.entries(projects)) {
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history: _history, ...cleanedConfig } = legacy
      cleanedProjects[projectPath] = cleanedConfig
    } else {
      cleanedProjects[projectPath] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

let freshnessWatcherStarted = false

function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  const file = getGlobalClaudeFile()
  watchFile(
    file,
    { interval: CONFIG_FRESHNESS_POLL_MS, persistent: false },
    curr => {
      if (curr.mtimeMs <= globalConfigCache.mtime) return
      void getFsImplementation()
        .readFile(file, { encoding: 'utf-8' })
        .then(content => {
          if (curr.mtimeMs <= globalConfigCache.mtime) return
          const parsed = safeParseJson(stripBom(content))
          if (parsed === null || typeof parsed !== 'object') return
          globalConfigCache = {
            config: migrateConfigFields({
              ...createDefaultGlobalConfig(),
              ...(parsed as Partial<GlobalConfig>),
            }),
            mtime: curr.mtimeMs,
          }
          lastReadFileStats = { mtime: curr.mtimeMs, size: curr.size }
        })
        .catch(() => {})
    },
  )
  registerCleanup(async () => {
    unwatchFile(file)
    freshnessWatcherStarted = false
  })
}

function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  lastReadFileStats = null
}

function getConfigBackupDir(): string {
  return join(getClaudeConfigHomeDir(), 'backups')
}

function findMostRecentBackup(file: string): string | null {
  const fsImpl = getFsImplementation()
  const fileBase = basename(file)
  const backupDir = getConfigBackupDir()

  try {
    const backups = fsImpl
      .readdirStringSync(backupDir)
      .filter(entry => entry.startsWith(`${fileBase}.backup.`))
      .sort()
    const mostRecent = backups.at(-1)
    if (mostRecent) {
      return join(backupDir, mostRecent)
    }
  } catch {
    // Backup dir absent
  }

  const fileDir = dirname(file)
  try {
    const backups = fsImpl
      .readdirStringSync(fileDir)
      .filter(entry => entry.startsWith(`${fileBase}.backup.`))
      .sort()
    const mostRecent = backups.at(-1)
    if (mostRecent) {
      return join(fileDir, mostRecent)
    }
    const legacyBackup = `${file}.backup`
    try {
      fsImpl.statSync(legacyBackup)
      return legacyBackup
    } catch {
      // No legacy backup
    }
  } catch {
    // Directory unreadable
  }

  return null
}

let configReadingAllowed = false

export function enableConfigs(): void {
  if (configReadingAllowed) {
    return
  }
  const startTime = Date.now()
  logForDiagnosticsNoPii('info', 'enable_configs_started')
  configReadingAllowed = true
  getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig, true)
  logForDiagnosticsNoPii('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

function getConfig<ConfigType>(
  file: string,
  createDefault: () => ConfigType,
  throwOnInvalid?: boolean,
): ConfigType {
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fsImpl = getFsImplementation()
  try {
    const fileContent = fsImpl.readFileSync(file, { encoding: 'utf-8' })
    try {
      const parsedConfig = jsonParse(stripBom(fileContent))
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(message, file, createDefault())
    }
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      const backupPath = findMostRecentBackup(file)
      if (backupPath) {
        process.stderr.write(
          `\nConfiguration file not found at: ${file}\n` +
            `A backup file exists at: ${backupPath}\n` +
            `You can manually restore it by running: cp "${backupPath}" "${file}"\n\n`,
        )
      }
      return createDefault()
    }

    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          logError(error)
          let hasBackup = false
          try {
            fsImpl.statSync(`${file}.backup`)
            hasBackup = true
          } catch {
            // No legacy backup
          }
          logEvent('tengu_config_parse_error', { has_backup: hasBackup })
        } finally {
          insideGetConfig = false
        }
      }
      process.stderr.write(
        `\nConfiguration file at ${file} is corrupted: ${error.message}\n`,
      )
      try {
        const fileBase = basename(file)
        const corruptedBackupDir = getConfigBackupDir()
        fsImpl.mkdirSync(corruptedBackupDir)
        const existingCorruptedBackups = fsImpl
          .readdirStringSync(corruptedBackupDir)
          .filter(entry => entry.startsWith(`${fileBase}.corrupted.`))
        const currentContent = fsImpl.readFileSync(file, { encoding: 'utf-8' })
        let alreadyBackedUp = false
        for (const backup of existingCorruptedBackups) {
          try {
            const backupContent = fsImpl.readFileSync(
              join(corruptedBackupDir, backup),
              { encoding: 'utf-8' },
            )
            if (currentContent === backupContent) {
              alreadyBackedUp = true
              break
            }
          } catch {
            // Ignore unreadable backup
          }
        }
        if (!alreadyBackedUp) {
          const corruptedBackupPath = join(
            corruptedBackupDir,
            `${fileBase}.corrupted.${Date.now()}`,
          )
          fsImpl.copyFileSync(file, corruptedBackupPath)
        }
      } catch {
        // Ignore backup errors
      }
    }

    return createDefault()
  }
}

function saveConfig<ConfigType extends object>(
  file: string,
  config: ConfigType,
  defaultConfig: ConfigType,
): void {
  const dir = dirname(file)
  const fsImpl = getFsImplementation()
  fsImpl.mkdirSync(dir)

  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !==
      jsonStringify(defaultConfig[key as keyof ConfigType]),
  )
  writeFileSyncAndFlushDeprecated(file, jsonStringify(filteredConfig, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
  if (file === getGlobalClaudeFile()) {
    globalConfigWriteCount++
  }
}

function saveConfigWithLock<ConfigType extends object>(
  file: string,
  createDefault: () => ConfigType,
  mergeFn: (current: ConfigType) => ConfigType,
): boolean {
  const defaultConfig = createDefault()
  const dir = dirname(file)
  const fsImpl = getFsImplementation()
  fsImpl.mkdirSync(dir)

  // proper-lockfile requires the target file to exist when locking
  if (!fsImpl.existsSync(file)) {
    writeFileSyncAndFlushDeprecated(file, '{}\n', {
      encoding: 'utf-8',
      mode: 0o600,
    })
  }

  let release: (() => void) | undefined
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: err => {
        logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logEvent('tengu_config_lock_contention', { lock_time_ms: lockTime })
    }

    if (lastReadFileStats && file === getGlobalClaudeFile()) {
      try {
        const currentStats = fsImpl.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          logEvent('tengu_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (error) {
        if (getErrnoCode(error) !== 'ENOENT') {
          throw error
        }
      }
    }

    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalClaudeFile() && wouldLoseAuthState(currentConfig)) {
      logEvent('tengu_config_auth_loss_prevented', {})
      return false
    }

    const mergedConfig = mergeFn(currentConfig)
    if (mergedConfig === currentConfig) {
      return false
    }

    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        jsonStringify(value) !==
        jsonStringify(defaultConfig[key as keyof ConfigType]),
    )

    try {
      const fileBase = basename(file)
      const backupDir = getConfigBackupDir()
      fsImpl.mkdirSync(backupDir)

      const existingBackups = fsImpl
        .readdirStringSync(backupDir)
        .filter(entry => entry.startsWith(`${fileBase}.backup.`))
        .sort()
        .reverse()

      const mostRecentBackup = existingBackups[0]
      const mostRecentTimestamp = mostRecentBackup
        ? Number(mostRecentBackup.split('.backup.').pop())
        : 0
      const shouldCreateBackup =
        Number.isNaN(mostRecentTimestamp) ||
        Date.now() - mostRecentTimestamp >= MIN_BACKUP_INTERVAL_MS

      if (shouldCreateBackup) {
        const backupPath = join(backupDir, `${fileBase}.backup.${Date.now()}`)
        fsImpl.copyFileSync(file, backupPath)
      }

      const backupsForCleanup = shouldCreateBackup
        ? fsImpl
            .readdirStringSync(backupDir)
            .filter(entry => entry.startsWith(`${fileBase}.backup.`))
            .sort()
            .reverse()
        : existingBackups

      for (const oldBackup of backupsForCleanup.slice(MAX_BACKUPS)) {
        try {
          fsImpl.unlinkSync(join(backupDir, oldBackup))
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') {
        logForDebugging(`Failed to backup config: ${error}`, { level: 'error' })
      }
    }

    writeFileSyncAndFlushDeprecated(
      file,
      jsonStringify(filteredConfig, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    )
    if (file === getGlobalClaudeFile()) {
      globalConfigWriteCount++
    }
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (shouldUseInMemoryTestConfig()) {
    const config = updater(testGlobalConfig)
    if (config === testGlobalConfig) {
      return
    }
    testGlobalConfig = config
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        if (config === current) {
          return current
        }
        written = {
          ...config,
          projects: removeProjectHistory(config.projects ?? current.projects),
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    const currentConfig = getConfig(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseAuthState(currentConfig)) {
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(config.projects ?? currentConfig.projects),
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function getGlobalConfig(): GlobalConfig {
  if (shouldUseInMemoryTestConfig()) {
    return testGlobalConfig
  }

  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  configCacheMisses++
  try {
    let stats: { mtimeMs: number; size: number } | null = null
    try {
      stats = getFsImplementation().statSync(getGlobalClaudeFile())
    } catch {
      // File absent
    }
    const config = migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: stats?.mtimeMs ?? Date.now(),
    }
    lastReadFileStats = stats
      ? { mtime: stats.mtimeMs, size: stats.size }
      : null
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    return migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
  }
}

export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit
  return false
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = gitRootFinder?.(originalCwd) ?? null
  if (gitRoot) {
    return normalizePathForConfigKey(gitRoot)
  }
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (shouldUseInMemoryTestConfig()) {
    return testProjectConfig
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJson(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (shouldUseInMemoryTestConfig()) {
    const config = updater(testProjectConfig)
    if (config === testProjectConfig) {
      return
    }
    testProjectConfig = config
    return
  }

  const absolutePath = getProjectPathForConfig()
  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save project config with lock: ${error}`, {
      level: 'error',
    })
    const config = getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(config)) {
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC)) {
    return {
      type: 'env',
      envVar: 'COPILOT_CLI_DISABLE_NONESSENTIAL_TRAFFIC',
    }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' ||
      config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export function getOrCreateUserId(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }
  const userId = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID: userId }))
  return userId
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()
  switch (memoryType) {
    case 'User':
      return join(getClaudeConfigHomeDir(), 'INSTRUCTIONS.md')
    case 'Local':
      return join(cwd, 'INSTRUCTIONS.local.md')
    case 'Project':
      return join(cwd, 'INSTRUCTIONS.md')
    case 'Managed':
      return join(getManagedFilePath(), 'INSTRUCTIONS.md')
    case 'AutoMem':
      return (
        autoMemEntrypointProvider?.() ??
        join(getClaudeConfigHomeDir(), 'memory', 'MEMORY.md')
      )
    case 'TeamMem':
      return isFeatureEnabled('TEAMMEM')
        ? (teamMemEntrypointProvider?.() ?? '')
        : ''
  }
}

export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), '.copilot', 'rules')
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudeConfigHomeDir(), 'rules')
}

export const getConfigForTesting = getConfig
export const wouldLoseAuthStateForTesting = wouldLoseAuthState

export function setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}

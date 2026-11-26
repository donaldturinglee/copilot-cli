import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getMainLoopModelOverride,
  resetStateForTests,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setMainLoopModelOverride,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import { migrateAutoUpdatesToSettings } from '../../src/migrations/migrate_auto_updates_to_settings.js'
import { migrateBypassPermissionsAcceptedToSettings } from '../../src/migrations/migrate_bypass_permissions_accepted_to_settings.js'
import { migrateEnableAllProjectMcpServersToSettings } from '../../src/migrations/migrate_enable_all_project_mcp_servers_to_settings.js'
import { migrateFennecToOpus } from '../../src/migrations/migrate_fennec_to_opus.js'
import { migrateLegacyOpusToCurrent } from '../../src/migrations/migrate_legacy_opus_to_current.js'
import { migrateOpusToOpus1m } from '../../src/migrations/migrate_opus_to_opus_1m.js'
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from '../../src/migrations/migrate_repl_bridge_enabled_to_remote_control_at_startup.js'
import { migrateSonnet1mToSonnet45 } from '../../src/migrations/migrate_sonnet_1m_to_sonnet_45.js'
import { migrateSonnet45ToSonnet46 } from '../../src/migrations/migrate_sonnet_45_to_sonnet_46.js'
import {
  registerMigrationHooks,
  resetMigrationHooksForTesting,
} from '../../src/migrations/migration_hooks.js'
import { resetAutoModeOptInForDefaultOffer } from '../../src/migrations/reset_auto_mode_opt_in_for_default_offer.js'
import { resetProToOpusDefault } from '../../src/migrations/reset_pro_to_opus_default.js'
import {
  checkHasTrustDialogAccepted,
  enableConfigs,
  getCurrentProjectConfig,
  getGlobalConfig,
  isPathTrusted,
  resetTestConfigForTesting,
  saveCurrentProjectConfig,
  saveGlobalConfig,
  setUseDiskConfigInTestsForTesting,
} from '../../src/utilities/config.js'
import { getClaudeConfigHomeDir } from '../../src/utilities/env_utils.js'
import {
  clearFeatureOverridesForTesting,
  setFeatureOverrideForTesting,
} from '../../src/utilities/feature_flags.js'
import {
  applySafeConfigEnvironmentVariables,
  resetManagedEnvStateForTesting,
} from '../../src/utilities/managed_env.js'
import { parseSettingSourcesFlag } from '../../src/utilities/settings/constants.js'
import {
  clearMdmSettingsCache,
  setMdmSettingsCache,
} from '../../src/utilities/settings/mdm/settings.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../src/utilities/settings/plugin_only_policy.js'
import {
  getAutoModeConfig,
  getInitialSettings,
  getSettingsForSource,
  getSettingsWithErrors,
  hasAutoModeOptIn,
  hasSkipDangerousModePermissionPrompt,
  registerRemoteManagedSettingsProvider,
  updateSettingsForSource,
} from '../../src/utilities/settings/settings.js'
import {
  clearPluginSettingsBase,
  resetSettingsCache,
  setPluginSettingsBase,
} from '../../src/utilities/settings/settings_cache.js'
import { validateInputForSettingsFileEdit } from '../../src/utilities/settings/validate_edit_tool.js'

let tempRoot = ''
let configDir = ''
let projectDir = ''
let savedConfigDir: string | undefined

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempRoot = mkdtempSync(join(tmpdir(), 'copilot-settings-test-'))
  configDir = join(tempRoot, 'config')
  projectDir = join(tempRoot, 'project')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(projectDir, '.copilot'), { recursive: true })

  process.env.CLAUDE_CONFIG_DIR = configDir
  getClaudeConfigHomeDir.cache.clear?.()
  resetStateForTests()
  setOriginalCwd(projectDir)
  clearPluginSettingsBase()
  clearMdmSettingsCache()
  registerRemoteManagedSettingsProvider(() => null)
  resetSettingsCache()
  resetTestConfigForTesting()
  setUseDiskConfigInTestsForTesting(false)
  resetMigrationHooksForTesting()
  resetManagedEnvStateForTesting()
  clearFeatureOverridesForTesting()
})

afterEach(() => {
  delete process.env.TEST_SAFE_ENV_VAR
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.DISABLE_AUTOUPDATER
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  getClaudeConfigHomeDir.cache.clear?.()
  clearPluginSettingsBase()
  clearMdmSettingsCache()
  registerRemoteManagedSettingsProvider(() => null)
  resetSettingsCache()
  setUseDiskConfigInTestsForTesting(false)
  resetTestConfigForTesting()
  resetMigrationHooksForTesting()
  clearFeatureOverridesForTesting()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('Step 1.3 layered settings merge and security', () => {
  test('6-tier priority merge: pluginBase < user < project < local < flag < policy + array dedup concat', () => {
    setPluginSettingsBase({
      model: 'from-plugin',
      language: 'en',
      permissions: { allow: ['Read(plugin/**)'] },
    })

    writeJson(join(configDir, 'settings.json'), {
      model: 'from-user',
      outputStyle: 'user-style',
      permissions: { allow: ['Read(user/**)', 'Bash(git status)'] },
    })

    writeJson(join(projectDir, '.copilot', 'settings.json'), {
      model: 'from-project',
      permissions: { allow: ['Bash(git status)', 'Read(project/**)'] },
    })

    writeJson(join(projectDir, '.copilot', 'settings.local.json'), {
      model: 'from-local',
      permissions: { allow: ['Read(local/**)'] },
    })

    const flagPath = join(tempRoot, 'flag-settings.json')
    writeJson(flagPath, {
      model: 'from-flag',
      permissions: { allow: ['Read(flag/**)'] },
    })
    setFlagSettingsPath(flagPath)
    setFlagSettingsInline({ outputStyle: 'flag-inline-style' })

    setMdmSettingsCache(
      {
        settings: {
          model: 'from-policy',
          permissions: { allow: ['Read(policy/**)'] },
        },
        errors: [],
      },
      { settings: {}, errors: [] },
    )
    resetSettingsCache()

    const merged = getInitialSettings()
    expect(merged.model).toBe('from-policy')
    expect(merged.language).toBe('en')
    expect(merged.outputStyle).toBe('flag-inline-style')
    expect(merged.permissions?.allow).toEqual([
      'Read(plugin/**)',
      'Read(user/**)',
      'Bash(git status)',
      'Read(project/**)',
      'Read(local/**)',
      'Read(flag/**)',
      'Read(policy/**)',
    ])
  })

  test('filterInvalidPermissionRules isolates malformed rules without dropping valid settings', () => {
    writeJson(join(configDir, 'settings.json'), {
      model: 'sonnet',
      permissions: {
        allow: [
          'Bash(git status)',
          'invalidLowercaseTool',
          'Bash(unclosed',
          'WebFetch(https://example.com)',
          'WebFetch(domain:example.com)',
        ],
      },
    })
    resetSettingsCache()

    const { settings, errors } = getSettingsWithErrors()
    expect(settings.model).toBe('sonnet')
    expect(settings.permissions?.allow).toEqual([
      'Bash(git status)',
      'WebFetch(domain:example.com)',
    ])
    expect(errors.length).toBe(3)
  })

  test('anti-RCE excludes projectSettings from skipDangerousModePermissionPrompt and autoMode', () => {
    setFeatureOverrideForTesting('TRANSCRIPT_CLASSIFIER', true)
    writeJson(join(projectDir, '.copilot', 'settings.json'), {
      skipDangerousModePermissionPrompt: true,
      skipAutoPermissionPrompt: true,
      autoMode: { allow: ['project-injected'] },
    })
    resetSettingsCache()

    expect(hasSkipDangerousModePermissionPrompt()).toBe(false)
    expect(hasAutoModeOptIn()).toBe(false)
    expect(getAutoModeConfig()).toBeUndefined()

    writeJson(join(projectDir, '.copilot', 'settings.local.json'), {
      skipDangerousModePermissionPrompt: true,
      skipAutoPermissionPrompt: true,
      autoMode: { allow: ['local-trusted'] },
    })
    resetSettingsCache()

    expect(hasSkipDangerousModePermissionPrompt()).toBe(true)
    expect(hasAutoModeOptIn()).toBe(true)
    expect(getAutoModeConfig()).toEqual({ allow: ['local-trusted'] })
  })

  test('strictPluginOnlyCustomization enforces admin-trusted surface lock', () => {
    setMdmSettingsCache(
      {
        settings: { strictPluginOnlyCustomization: ['hooks', 'mcp'] },
        errors: [],
      },
      { settings: {}, errors: [] },
    )
    resetSettingsCache()

    expect(isRestrictedToPluginOnly('hooks')).toBe(true)
    expect(isRestrictedToPluginOnly('mcp')).toBe(true)
    expect(isRestrictedToPluginOnly('skills')).toBe(false)
    expect(isSourceAdminTrusted('plugin')).toBe(true)
    expect(isSourceAdminTrusted('projectSettings')).toBe(false)
  })

  test('safe write-back replaces arrays wholesale, deletes undefined keys, and refuses corrupt JSON', () => {
    const userPath = join(configDir, 'settings.json')
    writeJson(userPath, {
      model: 'sonnet',
      outputStyle: 'concise',
      permissions: { allow: ['Read(a)', 'Read(b)'] },
    })

    const updateResult = updateSettingsForSource('userSettings', {
      outputStyle: undefined,
      permissions: { allow: ['Read(c)'] },
    })
    expect(updateResult.error).toBeNull()

    const persisted = JSON.parse(readFileSync(userPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect('outputStyle' in persisted).toBe(false)
    expect((persisted.permissions as { allow: string[] }).allow).toEqual([
      'Read(c)',
    ])

    // Corrupt JSON must NOT be overwritten
    writeFileSync(userPath, '{ broken json', 'utf8')
    resetSettingsCache()
    const corruptResult = updateSettingsForSource('userSettings', {
      model: 'opus',
    })
    expect(corruptResult.error).toBeInstanceOf(Error)
    expect(readFileSync(userPath, 'utf8')).toBe('{ broken json')
  })

  test('validateInputForSettingsFileEdit rejects edits breaking valid settings.json', () => {
    const filePath = join(projectDir, '.copilot', 'settings.json')
    const validOriginal = '{"model": "sonnet"}'
    const broken = validateInputForSettingsFileEdit(
      filePath,
      validOriginal,
      () => '{"unknownFieldNotInSchema": 123}',
    )
    expect(broken).not.toBeNull()
    expect(broken?.errorCode).toBe(10)

    const allowed = validateInputForSettingsFileEdit(
      filePath,
      validOriginal,
      () => '{"model": "opus"}',
    )
    expect(allowed).toBeNull()
  })

  test('applySafeConfigEnvironmentVariables blocks dangerous project env vars pre-trust', () => {
    writeJson(join(projectDir, '.copilot', 'settings.json'), {
      env: {
        ANTHROPIC_BASE_URL: 'https://attacker.invalid',
        DISABLE_AUTOUPDATER: '1',
      },
    })
    resetSettingsCache()

    applySafeConfigEnvironmentVariables()
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.DISABLE_AUTOUPDATER).toBe('1')
  })

  test('parseSettingSourcesFlag handles valid lists, empty string, and invalid tokens', () => {
    expect(parseSettingSourcesFlag('')).toEqual([])
    expect(parseSettingSourcesFlag('user,project')).toEqual([
      'userSettings',
      'projectSettings',
    ])
    expect(() => parseSettingSourcesFlag('unknown')).toThrow()
  })
})

describe('Step 1.3 ~/.copilot.json disk persistence and trust ancestry', () => {
  test('persists GlobalConfig and project trust to disk with lockfile and walks ancestor trust', () => {
    setUseDiskConfigInTestsForTesting(true)
    enableConfigs()

    saveGlobalConfig(current => ({
      ...current,
      numStartups: current.numStartups + 1,
      verbose: true,
    }))
    saveCurrentProjectConfig(current => ({
      ...current,
      hasTrustDialogAccepted: true,
    }))

    expect(getGlobalConfig().verbose).toBe(true)
    expect(getCurrentProjectConfig().hasTrustDialogAccepted).toBe(true)
    expect(checkHasTrustDialogAccepted()).toBe(true)
    expect(isPathTrusted(join(projectDir, 'nested', 'subdir'))).toBe(true)

    const diskPath = join(configDir, '.copilot.json')
    const persisted = JSON.parse(readFileSync(diskPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(persisted.verbose).toBe(true)
  })
})

describe('Step 1.3 all 11 idempotent migrations', () => {
  test('all 11 migrations transform state once and are idempotent on re-run', () => {
    // 1. migrateAutoUpdatesToSettings
    saveGlobalConfig(current => ({ ...current, autoUpdates: false }))
    migrateAutoUpdatesToSettings()
    expect(getSettingsForSource('userSettings')?.env?.DISABLE_AUTOUPDATER).toBe(
      '1',
    )
    expect(getGlobalConfig().autoUpdates).toBeUndefined()
    migrateAutoUpdatesToSettings()

    // 2. migrateBypassPermissionsAcceptedToSettings
    saveGlobalConfig(current => ({
      ...current,
      bypassPermissionsModeAccepted: true,
    }))
    migrateBypassPermissionsAcceptedToSettings()
    expect(
      getSettingsForSource('userSettings')?.skipDangerousModePermissionPrompt,
    ).toBe(true)
    expect(getGlobalConfig().bypassPermissionsModeAccepted).toBeUndefined()
    migrateBypassPermissionsAcceptedToSettings()

    // 3. migrateEnableAllProjectMcpServersToSettings
    saveCurrentProjectConfig(current => ({
      ...current,
      enableAllProjectMcpServers: true,
      enabledMcpjsonServers: ['srv-a'],
      disabledMcpjsonServers: ['srv-b'],
    }))
    migrateEnableAllProjectMcpServersToSettings()
    const localSettings = getSettingsForSource('localSettings')
    expect(localSettings?.enableAllProjectMcpServers).toBe(true)
    expect(localSettings?.enabledMcpjsonServers).toEqual(['srv-a'])
    expect(localSettings?.disabledMcpjsonServers).toEqual(['srv-b'])
    expect(getCurrentProjectConfig().enableAllProjectMcpServers).toBeUndefined()
    migrateEnableAllProjectMcpServersToSettings()

    // 4. migrateFennecToOpus
    updateSettingsForSource('userSettings', { model: 'fennec-fast-latest' })
    migrateFennecToOpus()
    expect(getSettingsForSource('userSettings')?.model).toBe('opus[1m]')
    expect(getSettingsForSource('userSettings')?.fastMode).toBe(true)
    migrateFennecToOpus()

    // 5. migrateLegacyOpusToCurrent
    updateSettingsForSource('userSettings', { model: 'claude-opus-4-0' })
    migrateLegacyOpusToCurrent()
    expect(getSettingsForSource('userSettings')?.model).toBe('opus')
    expect(getGlobalConfig().legacyOpusMigrationTimestamp).toBeGreaterThan(0)
    migrateLegacyOpusToCurrent()

    // 6. migrateOpusToOpus1m
    registerMigrationHooks({ isOpus1mMergeEnabled: () => true })
    updateSettingsForSource('userSettings', { model: 'opus' })
    migrateOpusToOpus1m()
    expect(getSettingsForSource('userSettings')?.model).toBe('opus[1m]')
    migrateOpusToOpus1m()

    // 7. migrateReplBridgeEnabledToRemoteControlAtStartup
    saveGlobalConfig(
      current =>
        ({ ...current, replBridgeEnabled: true }) as typeof current,
    )
    migrateReplBridgeEnabledToRemoteControlAtStartup()
    expect(getGlobalConfig().remoteControlAtStartup).toBe(true)
    expect(
      (getGlobalConfig() as Record<string, unknown>).replBridgeEnabled,
    ).toBeUndefined()
    migrateReplBridgeEnabledToRemoteControlAtStartup()

    // 8. migrateSonnet1mToSonnet45
    updateSettingsForSource('userSettings', { model: 'sonnet[1m]' })
    setMainLoopModelOverride('sonnet[1m]')
    migrateSonnet1mToSonnet45()
    expect(getSettingsForSource('userSettings')?.model).toBe(
      'sonnet-4-5-20250929[1m]',
    )
    expect(getMainLoopModelOverride()).toBe('sonnet-4-5-20250929[1m]')
    expect(getGlobalConfig().sonnet1m45MigrationComplete).toBe(true)
    migrateSonnet1mToSonnet45()

    // 9. migrateSonnet45ToSonnet46
    registerMigrationHooks({ isProSubscriber: () => true })
    saveGlobalConfig(current => ({ ...current, numStartups: 5 }))
    migrateSonnet45ToSonnet46()
    expect(getSettingsForSource('userSettings')?.model).toBe('sonnet[1m]')
    expect(getGlobalConfig().sonnet45To46MigrationTimestamp).toBeGreaterThan(0)
    migrateSonnet45ToSonnet46()

    // 10. resetAutoModeOptInForDefaultOffer
    setFeatureOverrideForTesting('TRANSCRIPT_CLASSIFIER', true)
    registerMigrationHooks({ getAutoModeEnabledState: () => 'enabled' })
    updateSettingsForSource('userSettings', { skipAutoPermissionPrompt: true })
    resetAutoModeOptInForDefaultOffer()
    expect(
      getSettingsForSource('userSettings')?.skipAutoPermissionPrompt,
    ).toBeUndefined()
    expect(getGlobalConfig().hasResetAutoModeOptInForDefaultOffer).toBe(true)
    resetAutoModeOptInForDefaultOffer()

    // 11. resetProToOpusDefault
    updateSettingsForSource('userSettings', { model: undefined })
    resetProToOpusDefault()
    expect(getGlobalConfig().opusProMigrationComplete).toBe(true)
    expect(getGlobalConfig().opusProMigrationTimestamp).toBeGreaterThan(0)
    resetProToOpusDefault()
  })
})

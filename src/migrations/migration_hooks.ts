import { isEnvTruthy } from '../utils/env_utils.js'

export type ApiProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

export type MigrationHooks = {
  getApiProvider: () => ApiProvider
  isLegacyModelRemapEnabled: () => boolean
  isOpus1mMergeEnabled: () => boolean
  getDefaultMainLoopModelSetting: () => string
  parseUserSpecifiedModel: (model: string) => string
  isProSubscriber: () => boolean
  isMaxSubscriber: () => boolean
  isTeamPremiumSubscriber: () => boolean
  getAutoModeEnabledState: () => 'enabled' | 'opt-in' | 'disabled'
}

function defaultGetApiProvider(): ApiProvider {
  if (isEnvTruthy(process.env.COPILOT_CLI_USE_BEDROCK)) return 'bedrock'
  if (isEnvTruthy(process.env.COPILOT_CLI_USE_VERTEX)) return 'vertex'
  if (isEnvTruthy(process.env.COPILOT_CLI_USE_FOUNDRY)) return 'foundry'
  return 'firstParty'
}

const DEFAULT_HOOKS: MigrationHooks = {
  getApiProvider: defaultGetApiProvider,
  isLegacyModelRemapEnabled: () => true,
  isOpus1mMergeEnabled: () => false,
  getDefaultMainLoopModelSetting: () => 'sonnet',
  parseUserSpecifiedModel: model => model,
  isProSubscriber: () => false,
  isMaxSubscriber: () => false,
  isTeamPremiumSubscriber: () => false,
  getAutoModeEnabledState: () => 'disabled',
}

let activeHooks: MigrationHooks = { ...DEFAULT_HOOKS }

export function getMigrationHooks(): MigrationHooks {
  return activeHooks
}

export function registerMigrationHooks(
  overrides: Partial<MigrationHooks>,
): void {
  activeHooks = { ...activeHooks, ...overrides }
}

export function resetMigrationHooksForTesting(): void {
  activeHooks = { ...DEFAULT_HOOKS }
}

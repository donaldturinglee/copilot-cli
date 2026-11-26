/**
 * Internal ant-only model override lookup backed by GrowthBook config.
 */

import { getFeatureValueCachedMayBeStale } from '../../services/analytics/growthbook.js'

export interface AntModelDefinition {
  id: string
  alias?: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsMaxEffort?: boolean
}

export interface AntModelOverrideConfig {
  defaultModel?: string
  models?: AntModelDefinition[]
  systemPromptNotice?: string
}

/**
 * Returns the ant model override config when running in ant builds, else null.
 */
export function getAntModelOverrideConfig(): AntModelOverrideConfig | null {
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  const config = getFeatureValueCachedMayBeStale<AntModelOverrideConfig | null>(
    'tengu_ant_model_override',
    null,
  )
  return config && typeof config === 'object' ? config : null
}

/**
 * Returns configured internal ant models (empty in external builds).
 */
export function getAntModels(): AntModelDefinition[] {
  return getAntModelOverrideConfig()?.models ?? []
}

/**
 * Resolves an alias or ID against configured internal ant models.
 */
export function resolveAntModel(input: string): AntModelDefinition | undefined {
  const lower = input.toLowerCase()
  return getAntModels().find(
    m => m.id.toLowerCase() === lower || m.alias?.toLowerCase() === lower,
  )
}

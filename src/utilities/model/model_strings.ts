/**
 * Runtime provider model-string table with lazy Bedrock inference profile
 * hydration and `settings.modelOverrides` overlay.
 */

import {
  getModelStrings as getModelStringsFromState,
  resetModelStringsForTesting,
  setModelStrings as setModelStringsInState,
} from '../../bootstrap/state.js'
import type { ModelStrings } from '../../types/forward.js'
import { sequential } from '../sequential.js'
import { getInitialSettings } from '../settings/settings.js'
import { getBedrockInferenceProfiles } from './bedrock.js'
import {
  ALL_MODEL_CONFIGS,
  CANONICAL_ID_TO_KEY,
  type ModelKey,
} from './configs.js'
import { getApiProvider } from './providers.js'

function buildDefaultModelStringsForProvider(): Record<ModelKey, string> {
  const provider = getApiProvider()
  const result = {} as Record<ModelKey, string>
  for (const [key, cfg] of Object.entries(ALL_MODEL_CONFIGS) as Array<
    [ModelKey, (typeof ALL_MODEL_CONFIGS)[ModelKey]]
  >) {
    result[key] = cfg[provider]
  }
  return result
}

function applySettingsModelOverrides(
  base: Record<ModelKey, string>,
): Record<ModelKey, string> {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) {
    return base
  }
  const merged = { ...base }
  for (const [canonicalId, replacement] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId]
    if (key && replacement) {
      merged[key] = replacement
    }
  }
  return merged
}

let bedrockHydrated = false

const updateBedrockModelStrings = sequential(async (): Promise<void> => {
  if (bedrockHydrated || getApiProvider() !== 'bedrock') {
    return
  }
  const profiles = await getBedrockInferenceProfiles()
  if (profiles.length === 0) {
    bedrockHydrated = true
    return
  }
  const current = {
    ...buildDefaultModelStringsForProvider(),
    ...(getModelStringsFromState() ?? {}),
  } as Record<ModelKey, string>

  for (const [key, cfg] of Object.entries(ALL_MODEL_CONFIGS) as Array<
    [ModelKey, (typeof ALL_MODEL_CONFIGS)[ModelKey]]
  >) {
    const matchedProfile = profiles.find(profile =>
      profile.includes(cfg.firstParty),
    )
    if (matchedProfile) {
      current[key] = matchedProfile
    }
  }
  setModelStringsInState(current)
  bedrockHydrated = true
})

/**
 * Synchronously returns the active model-ID mapping for the current provider,
 * applying `settings.modelOverrides`. On Bedrock, triggers background profile discovery.
 */
export function getModelStrings(): Record<ModelKey, string> {
  let cached = getModelStringsFromState()
  if (!cached) {
    const defaults = buildDefaultModelStringsForProvider()
    setModelStringsInState(defaults)
    cached = defaults
    if (getApiProvider() === 'bedrock' && !bedrockHydrated) {
      void updateBedrockModelStrings()
    }
  }
  return applySettingsModelOverrides(cached as Record<ModelKey, string>)
}

/**
 * Awaits Bedrock inference profile hydration when running on Bedrock.
 */
export async function ensureModelStringsInitialized(): Promise<void> {
  getModelStrings()
  if (getApiProvider() === 'bedrock' && !bedrockHydrated) {
    await updateBedrockModelStrings()
  }
}

/**
 * Reverse-maps a custom `settings.modelOverrides` value back to its canonical
 * first-party model ID so pricing and capability lookups stay accurate.
 */
export function resolveOverriddenModel(modelId: string): string {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) {
    return modelId
  }
  for (const [canonicalId, overrideValue] of Object.entries(overrides)) {
    if (overrideValue === modelId) {
      return canonicalId
    }
  }
  return modelId
}

/**
 * Resets cached model strings and Bedrock hydration flag for tests.
 */
export function resetModelStringsStateForTesting(): void {
  bedrockHydrated = false
  resetModelStringsForTesting()
}

export type { ModelStrings }

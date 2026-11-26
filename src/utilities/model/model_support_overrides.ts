/**
 * Third-party model capability overrides configured via
 * `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL_SUPPORTED_CAPABILITIES`.
 */

import memoize from 'lodash-es/memoize.js'
import { getApiProvider } from './providers.js'

export type OverridableModelCapability =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

const OVERRIDE_ENV_PAIRS: ReadonlyArray<[string, string]> = [
  [
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  ],
  [
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  ],
  [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  ],
]

/**
 * Checks whether a 3P model deployment has an explicit capability override
 * configured via environment variables. Returns `undefined` when no override
 * applies.
 */
export const get3pModelCapabilityOverride = memoize(
  (
    model: string,
    capability: OverridableModelCapability,
  ): boolean | undefined => {
    if (getApiProvider() === 'firstParty') {
      return undefined
    }
    const normalizedModel = model.replace(/\[(1|2)m\]/gi, '').trim()
    for (const [modelEnvKey, capsEnvKey] of OVERRIDE_ENV_PAIRS) {
      const configuredModel = process.env[modelEnvKey]?.trim()
      const rawCaps = process.env[capsEnvKey]
      if (!configuredModel || rawCaps === undefined) {
        continue
      }
      if (configuredModel === normalizedModel) {
        const caps = rawCaps
          .split(',')
          .map(item => item.trim().toLowerCase())
          .filter(Boolean)
        return caps.includes(capability)
      }
    }
    return undefined
  },
  (model: string, capability: OverridableModelCapability) =>
    `${getApiProvider()}:${model}:${capability}:${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? ''}:${process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES ?? ''}:${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? ''}:${process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES ?? ''}:${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? ''}:${process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES ?? ''}`,
)

/**
 * Clears cached 3P capability override lookups (for tests).
 */
export function clear3pModelCapabilityOverrideCache(): void {
  get3pModelCapabilityOverride.cache.clear?.()
}

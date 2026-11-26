/**
 * Builds selectable `/model` picker options tailored to account tier, API
 * provider, custom environment overrides, and enterprise `availableModels`.
 */

import type { ModelOption } from '../../types/forward.js'
import {
  isClaudeAiSubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getGlobalConfig } from '../config.js'
import {
  getDefaultHaikuModel,
  getDefaultMainLoopModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getPublicModelName,
  isOpus1mMergeEnabled,
} from './model.js'
import { isModelAllowed } from './model_allowlist.js'
import { getApiProvider } from './providers.js'

export interface SelectableModelOption {
  value: string | null
  label: string
  description?: string
}

/**
 * Returns the ordered list of model picker options filtered by `availableModels`.
 */
export function getModelOptions(currentModel?: string | null): SelectableModelOption[] {
  const options: SelectableModelOption[] = []
  const provider = getApiProvider()
  const defaultModelName = getPublicModelName(getDefaultMainLoopModel())

  options.push({
    value: null,
    label: 'Default (recommended)',
    description: `Use the default model (${defaultModelName})`,
  })

  if (provider !== 'firstParty') {
    const opusName =
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME ||
      getPublicModelName(getDefaultOpusModel())
    const sonnetName =
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME ||
      getPublicModelName(getDefaultSonnetModel())
    const haikuName =
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME ||
      getPublicModelName(getDefaultHaikuModel())

    options.push(
      {
        value: 'opus',
        label: opusName,
        description:
          process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION ||
          'Most capable for complex work',
      },
      {
        value: 'sonnet',
        label: sonnetName,
        description:
          process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION ||
          'Best for everyday coding tasks',
      },
      {
        value: 'haiku',
        label: haikuName,
        description:
          process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION ||
          'Fastest for quick answers',
      },
    )
  } else {
    const opusValue =
      (isMaxSubscriber() || isTeamPremiumSubscriber()) && isOpus1mMergeEnabled()
        ? 'opus[1m]'
        : 'opus'
    options.push(
      {
        value: opusValue,
        label: getPublicModelName(
          opusValue === 'opus[1m]'
            ? `${getDefaultOpusModel()}[1m]`
            : getDefaultOpusModel(),
        ),
        description: 'Most capable for complex work',
      },
      {
        value: 'sonnet',
        label: getPublicModelName(getDefaultSonnetModel()),
        description: 'Best for everyday coding tasks',
      },
      {
        value: 'haiku',
        label: getPublicModelName(getDefaultHaikuModel()),
        description: 'Fastest for quick answers',
      },
    )

    if (!isClaudeAiSubscriber() || isMaxSubscriber()) {
      options.push({
        value: 'opusplan',
        label: 'Opus Plan Mode',
        description: 'Use Opus for planning and Sonnet for execution',
      })
    }
  }

  const customOption = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (customOption) {
    options.push({
      value: customOption,
      label:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME || customOption,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ||
        'Custom model option',
    })
  }

  const cachedAdditional: ModelOption[] =
    getGlobalConfig().additionalModelOptionsCache ?? []
  for (const extra of cachedAdditional) {
    if (!options.some(opt => opt.value === extra.value)) {
      options.push(extra)
    }
  }

  if (
    currentModel &&
    !options.some(opt => opt.value === currentModel)
  ) {
    options.push({
      value: currentModel,
      label: getPublicModelName(currentModel),
      description: 'Currently configured model',
    })
  }

  return options.filter(
    opt => opt.value === null || isModelAllowed(opt.value),
  )
}

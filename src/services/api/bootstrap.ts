/**
 * Fetches CLI bootstrap configuration (`/api/claude_cli/bootstrap`) and caches
 * `client_data` and `additional_model_options` in global config.
 */

import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import { z } from 'zod/v4'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utilities/config.js'
import { getAuthHeaders, withOauth401Retry } from '../../utilities/http.js'
import { logError } from '../../utilities/log.js'
import { getApiProvider } from '../../utilities/model/providers.js'
import { isEssentialTrafficOnly } from '../../utilities/privacy_level.js'

const BOOTSTRAP_TIMEOUT_MS = 5_000

const BootstrapResponseSchema = z.object({
  client_data: z.record(z.string(), z.unknown()).nullable().optional(),
  additional_model_options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
})

export type BootstrapData = z.infer<typeof BootstrapResponseSchema>

/**
 * Fetches bootstrap metadata from Anthropic 1P API and persists changes to
 * `globalConfig` only when values differ.
 */
export async function fetchBootstrapData(): Promise<BootstrapData | null> {
  if (isEssentialTrafficOnly() || getApiProvider() !== 'firstParty') {
    return null
  }
  const initialHeaders = getAuthHeaders()
  if (initialHeaders.error) {
    return null
  }

  try {
    const response = await withOauth401Retry(
      () =>
        axios.get<unknown>(
          `${getOauthConfig().BASE_API_URL}/api/claude_cli/bootstrap`,
          {
            headers: getAuthHeaders().headers,
            timeout: BOOTSTRAP_TIMEOUT_MS,
          },
        ),
      { also403Revoked: true },
    )
    const parsed = BootstrapResponseSchema.safeParse(response.data)
    if (!parsed.success) {
      return null
    }

    const current = getGlobalConfig()
    const nextClientData = parsed.data.client_data ?? null
    const nextModelOptions = parsed.data.additional_model_options

    const clientDataChanged = !isEqual(current.clientDataCache, nextClientData)
    const modelOptionsChanged =
      nextModelOptions !== undefined &&
      !isEqual(current.additionalModelOptionsCache, nextModelOptions)

    if (clientDataChanged || modelOptionsChanged) {
      saveGlobalConfig(prev => ({
        ...prev,
        ...(clientDataChanged ? { clientDataCache: nextClientData } : {}),
        ...(modelOptionsChanged
          ? { additionalModelOptionsCache: nextModelOptions }
          : {}),
      }))
    }

    return parsed.data
  } catch (error) {
    logError(error)
    return null
  }
}

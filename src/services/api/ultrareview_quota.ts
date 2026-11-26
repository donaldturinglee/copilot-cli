/**
 * Fetches remaining Ultrareview quota for Claude.ai subscribers.
 */

import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import {
  getClaudeAiOauthTokens,
  getOrganizationUuid,
  isClaudeAiSubscriber,
} from '../../utilities/auth.js'
import { logForDebugging } from '../../utilities/debug.js'

export interface UltrareviewQuotaResponse {
  reviews_used: number
  reviews_limit: number
  reviews_remaining: number
  is_overage: boolean
}

const QUOTA_TIMEOUT_MS = 5_000

/**
 * Peeks the active user's ultrareview quota, returning `null` for non-subscribers
 * or on network/auth failure.
 */
export async function fetchUltrareviewQuota(): Promise<UltrareviewQuotaResponse | null> {
  if (!isClaudeAiSubscriber()) {
    return null
  }
  try {
    const accessToken = getClaudeAiOauthTokens()?.accessToken
    const orgUuid = await getOrganizationUuid()
    if (!accessToken || !orgUuid) {
      return null
    }
    const response = await axios.get<UltrareviewQuotaResponse>(
      `${getOauthConfig().BASE_API_URL}/v1/ultrareview/quota`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
          'x-organization-uuid': orgUuid,
        },
        timeout: QUOTA_TIMEOUT_MS,
      },
    )
    return response.data
  } catch (error) {
    logForDebugging(`fetchUltrareviewQuota failed: ${String(error)}`)
    return null
  }
}

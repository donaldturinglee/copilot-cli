/**
 * Fetches OAuth subscription utilization (`/api/oauth/usage`).
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAiOauthTokens,
  hasProfileScope,
  isClaudeAiSubscriber,
} from '../../utilities/auth.js'
import { getAuthHeaders } from '../../utilities/http.js'
import { logError } from '../../utilities/log.js'
import { isOauthTokenExpired } from '../oauth/client.js'

const USAGE_TIMEOUT_MS = 5_000

export interface UtilizationResponse {
  five_hour?: { utilization?: number; resets_at?: string | null }
  seven_day?: { utilization?: number; resets_at?: string | null }
  [key: string]: unknown
}

/**
 * Fetches account usage utilization from `/api/oauth/usage`.
 * Returns `{}` for non-subscribers or tokens without `user:profile`, and `null`
 * if the OAuth token is expired or the request fails.
 */
export async function fetchUtilization(): Promise<UtilizationResponse | null> {
  if (!isClaudeAiSubscriber() || !hasProfileScope()) {
    return {}
  }
  const tokens = getClaudeAiOauthTokens()
  if (!tokens || isOauthTokenExpired(tokens.expiresAt)) {
    return null
  }
  const authHeaders = getAuthHeaders()
  if (authHeaders.error) {
    return null
  }

  try {
    const response = await axios.get<UtilizationResponse>(
      `${getOauthConfig().BASE_API_URL}/api/oauth/usage`,
      {
        headers: authHeaders.headers,
        timeout: USAGE_TIMEOUT_MS,
      },
    )
    return response.data
  } catch (error) {
    logError(error)
    return null
  }
}

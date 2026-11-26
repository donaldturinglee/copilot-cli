/**
 * Fetches OAuth account and organization profile metadata via API key or bearer token.
 */

import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getGlobalConfig } from '../../utilities/config.js'
import { logError } from '../../utilities/log.js'
import type { OauthProfileResponse } from './types.js'

const PROFILE_TIMEOUT_MS = 10_000

/**
 * Fetches profile metadata using an Anthropic API key and stored account UUID.
 */
export async function getOauthProfileFromApiKey(
  apiKey: string,
): Promise<OauthProfileResponse | undefined> {
  const accountUuid = getGlobalConfig().oauthAccount?.accountUuid
  if (!apiKey || !accountUuid) {
    return undefined
  }
  try {
    const url = `${getOauthConfig().BASE_API_URL}/api/claude_cli_profile?account_uuid=${encodeURIComponent(accountUuid)}`
    const response = await axios.get<OauthProfileResponse>(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      timeout: PROFILE_TIMEOUT_MS,
    })
    return response.data
  } catch (error) {
    logError(error)
    return undefined
  }
}

/**
 * Fetches profile metadata using an OAuth bearer access token.
 */
export async function getOauthProfileFromOauthToken(
  accessToken: string,
): Promise<OauthProfileResponse | undefined> {
  if (!accessToken) {
    return undefined
  }
  try {
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/profile`
    const response = await axios.get<OauthProfileResponse>(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: PROFILE_TIMEOUT_MS,
    })
    return response.data
  } catch (error) {
    logError(error)
    return undefined
  }
}

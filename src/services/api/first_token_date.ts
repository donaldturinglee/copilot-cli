/**
 * Fetches and caches the organization's first Copilot CLI token timestamp.
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utilities/config.js'
import { getAuthHeaders } from '../../utilities/http.js'
import { logError } from '../../utilities/log.js'
import { getClaudeCodeUserAgent } from '../../utilities/user_agent.js'

const FIRST_TOKEN_TIMEOUT_MS = 10_000

/**
 * Fetches `/api/organization/claude_code_first_token_date` once and stores the
 * validated ISO date string in `globalConfig.claudeCodeFirstTokenDate`.
 */
export async function fetchAndStoreClaudeCodeFirstTokenDate(): Promise<void> {
  try {
    const config = getGlobalConfig()
    if (config.claudeCodeFirstTokenDate !== undefined) {
      return
    }

    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      logError(new Error(`Failed to get auth headers: ${authHeaders.error}`))
      return
    }

    const url = `${getOauthConfig().BASE_API_URL}/api/organization/claude_code_first_token_date`
    const response = await axios.get<{ first_token_date?: string | null }>(
      url,
      {
        headers: {
          ...authHeaders.headers,
          'User-Agent': getClaudeCodeUserAgent(),
        },
        timeout: FIRST_TOKEN_TIMEOUT_MS,
      },
    )

    const firstTokenDate = response.data?.first_token_date ?? null
    if (firstTokenDate !== null) {
      const parsedMs = new Date(firstTokenDate).getTime()
      if (Number.isNaN(parsedMs)) {
        logError(
          new Error(
            `Received invalid first_token_date from API: ${firstTokenDate}`,
          ),
        )
        return
      }
    }

    saveGlobalConfig(current => ({
      ...current,
      claudeCodeFirstTokenDate: firstTokenDate ?? undefined,
    }))
  } catch (error) {
    logError(error)
  }
}

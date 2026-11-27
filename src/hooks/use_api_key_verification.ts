import { useEffect, useState } from 'react'
import { getAnthropicApiKey } from '../utilities/auth.js'

export type ApiKeyVerificationState = {
  status: 'checking' | 'valid' | 'missing'
  hasKey: boolean
}

export function useApiKeyVerification(): ApiKeyVerificationState {
  const [state, setState] = useState<ApiKeyVerificationState>(() => {
    const key = getAnthropicApiKey()
    return { status: key ? 'valid' : 'missing', hasKey: Boolean(key) }
  })

  useEffect(() => {
    const key = getAnthropicApiKey()
    setState({ status: key ? 'valid' : 'missing', hasKey: Boolean(key) })
  }, [])

  return state
}

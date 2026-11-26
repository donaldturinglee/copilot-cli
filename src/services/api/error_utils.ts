/**
 * Low-level API connection, TLS/SSL certificate, and HTML error page formatting helpers.
 */

export const SSL_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_INVALID_PURPOSE',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE_ERROR',
])

const MAX_CAUSE_DEPTH = 5

export interface ConnectionErrorDetails {
  code?: string
  message?: string
}

/**
 * Walks an error's `.cause` chain (up to depth 5) to extract low-level socket
 * or TLS error codes (e.g. `ECONNRESET`, `ETIMEDOUT`, OpenSSL codes).
 */
export function extractConnectionErrorDetails(
  error: unknown,
): ConnectionErrorDetails | undefined {
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object') {
      break
    }
    const record = current as {
      code?: unknown
      message?: unknown
      cause?: unknown
    }
    if (typeof record.code === 'string' && record.code.length > 0) {
      return {
        code: record.code,
        message:
          typeof record.message === 'string' ? record.message : undefined,
      }
    }
    current = record.cause
  }
  return undefined
}

/**
 * Returns an actionable `NODE_EXTRA_CA_CERTS` hint when `error` is a TLS/SSL error.
 */
export function getSslErrorHint(error: unknown): string | undefined {
  const details = extractConnectionErrorDetails(error)
  if (!details?.code || !SSL_ERROR_CODES.has(details.code)) {
    return undefined
  }
  return `TLS certificate verification failed (${details.code}). If you are behind a corporate proxy, set NODE_EXTRA_CA_CERTS to your CA bundle.`
}

/**
 * Strips raw HTML error pages (e.g. Cloudflare 520/524 responses), preserving
 * only the `<title>` content when available.
 */
export function sanitizeApiError(rawMessage: string): string {
  const trimmed = rawMessage.trim()
  if (
    trimmed.startsWith('<!DOCTYPE html') ||
    trimmed.startsWith('<html') ||
    trimmed.includes('</html>')
  ) {
    const titleMatch = trimmed.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (titleMatch?.[1]) {
      return titleMatch[1].trim()
    }
    return 'Received an HTML error page from the API server.'
  }
  return rawMessage
}

/**
 * Formats an API or connection error into a clean, user-presentable message.
 */
export function formatApiError(error: unknown): string {
  const sslHint = getSslErrorHint(error)
  if (sslHint) {
    return sslHint
  }

  const connDetails = extractConnectionErrorDetails(error)
  if (connDetails?.code === 'ETIMEDOUT') {
    return 'Connection timed out while contacting the API.'
  }

  if (error instanceof Error) {
    const msg = error.message
    if (msg === 'Connection error.' && connDetails?.code) {
      return `Connection error (${connDetails.code}).`
    }
    return sanitizeApiError(msg)
  }

  if (error && typeof error === 'object') {
    const record = error as {
      message?: unknown
      error?: { message?: unknown; error?: { message?: unknown } }
    }
    if (typeof record.error?.error?.message === 'string') {
      return sanitizeApiError(record.error.error.message)
    }
    if (typeof record.error?.message === 'string') {
      return sanitizeApiError(record.error.message)
    }
    if (typeof record.message === 'string') {
      return sanitizeApiError(record.message)
    }
  }

  return sanitizeApiError(String(error))
}

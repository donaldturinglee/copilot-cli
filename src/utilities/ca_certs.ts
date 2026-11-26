import memoize from 'lodash-es/memoize.js'
import { hasNodeOption } from './env_utils.js'
import { getFsImplementation } from './fs_operations.js'
import { logError } from './log.js'

type SystemCaGetter = (type: 'system' | 'default' | 'extra') => string[]

/**
 * Loads combined CA certificates when `NODE_EXTRA_CA_CERTS` or `--use-system-ca` /
 * `--use-openssl-ca` is configured. Returns undefined when defaults apply.
 */
export const getCaCertificates = memoize((): string[] | undefined => {
  const useSystemCa =
    hasNodeOption('--use-system-ca') || hasNodeOption('--use-openssl-ca')
  const extraCertsPath = process.env.NODE_EXTRA_CA_CERTS

  if (!useSystemCa && !extraCertsPath) {
    return undefined
  }

  const tls = require('tls') as typeof import('tls')
  const tlsRecord = tls as unknown as Record<string, unknown>
  const systemCaGetter =
    typeof tlsRecord['getCACertificates'] === 'function'
      ? (tlsRecord['getCACertificates'] as SystemCaGetter)
      : undefined
  const certs: string[] = []

  if (useSystemCa) {
    const systemCerts = systemCaGetter?.('system')
    if (systemCerts && systemCerts.length > 0) {
      certs.push(...systemCerts)
    } else if (!systemCaGetter && !extraCertsPath) {
      return undefined
    } else {
      certs.push(...tls.rootCertificates)
    }
  } else {
    certs.push(...tls.rootCertificates)
  }

  if (extraCertsPath) {
    try {
      const extraCert = getFsImplementation().readFileSync(extraCertsPath, {
        encoding: 'utf-8',
      })
      if (extraCert.trim()) {
        certs.push(extraCert)
      }
    } catch (error) {
      logError(error)
    }
  }

  return certs.length > 0 ? certs : undefined
})

export function clearCaCertsCache(): void {
  getCaCertificates.cache.clear?.()
}

import { Agent as HttpsAgent } from 'https'
import memoize from 'lodash-es/memoize.js'
import type * as tls from 'tls'
import type * as undici from 'undici'
import { getCaCertificates } from './ca_certs.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fs_operations.js'
import { logError } from './log.js'

export type MtlsConfig = {
  cert?: string
  key?: string
  passphrase?: string
}

export type TlsConfig = MtlsConfig & {
  ca?: string | string[] | Buffer
}

export const getMtlsConfig = memoize((): MtlsConfig | undefined => {
  const certPath = process.env.COPILOT_CLI_CLIENT_CERT
  const keyPath = process.env.COPILOT_CLI_CLIENT_KEY
  const passphrase = process.env.COPILOT_CLI_CLIENT_KEY_PASSPHRASE

  if (!certPath && !keyPath && !passphrase) {
    return undefined
  }

  const config: MtlsConfig = {}
  const fsImpl = getFsImplementation()

  if (certPath) {
    try {
      config.cert = fsImpl.readFileSync(certPath, { encoding: 'utf-8' })
    } catch (error) {
      logError(error)
    }
  }

  if (keyPath) {
    try {
      config.key = fsImpl.readFileSync(keyPath, { encoding: 'utf-8' })
    } catch (error) {
      logError(error)
    }
  }

  if (passphrase) {
    config.passphrase = passphrase
  }

  return Object.keys(config).length > 0 ? config : undefined
})

export const getMtlsAgent = memoize((): HttpsAgent | undefined => {
  const mtlsConfig = getMtlsConfig()
  const caCerts = getCaCertificates()

  if (!mtlsConfig && !caCerts) {
    return undefined
  }

  return new HttpsAgent({
    ...mtlsConfig,
    ...(caCerts ? { ca: caCerts } : {}),
    keepAlive: true,
  })
})

export function getWebSocketTlsOptions(): tls.ConnectionOptions | undefined {
  const mtlsConfig = getMtlsConfig()
  const caCerts = getCaCertificates()
  if (!mtlsConfig && !caCerts) {
    return undefined
  }
  return {
    ...mtlsConfig,
    ...(caCerts ? { ca: caCerts } : {}),
  }
}

export function getTlsFetchOptions(): {
  tls?: TlsConfig
  dispatcher?: undici.Dispatcher
} {
  const mtlsConfig = getMtlsConfig()
  const caCerts = getCaCertificates()
  if (!mtlsConfig && !caCerts) {
    return {}
  }

  const tlsConfig: TlsConfig = {
    ...mtlsConfig,
    ...(caCerts ? { ca: caCerts } : {}),
  }

  if (typeof Bun !== 'undefined') {
    return { tls: tlsConfig }
  }

  const undiciMod = require('undici') as typeof import('undici')
  return {
    dispatcher: new undiciMod.Agent({
      connect: tlsConfig,
      pipelining: 1,
    }),
  }
}

export function clearMtlsCache(): void {
  getMtlsConfig.cache.clear?.()
  getMtlsAgent.cache.clear?.()
}

export function configureGlobalMtls(): void {
  const mtlsConfig = getMtlsConfig()
  if (mtlsConfig) {
    logForDebugging('Configured global mTLS client certificates')
  }
  if (process.env.NODE_EXTRA_CA_CERTS) {
    logForDebugging(
      `Using NODE_EXTRA_CA_CERTS from ${process.env.NODE_EXTRA_CA_CERTS}`,
    )
  }
}

import axios, { type AxiosInstance } from 'axios'
import type { LookupOptions } from 'dns'
import type { Agent } from 'http'
import {
  HttpsProxyAgent,
  type HttpsProxyAgentOptions,
} from 'https-proxy-agent'
import memoize from 'lodash-es/memoize.js'
import type * as undici from 'undici'
import { getCaCertificates } from './ca_certs.js'
import { isEnvTruthy } from './env_utils.js'
import {
  getMtlsAgent,
  getMtlsConfig,
  getTlsFetchOptions,
  type TlsConfig,
} from './mtls.js'

let keepAliveDisabled = false
let proxyInterceptorId: number | null = null

export function disableKeepAlive(): void {
  keepAliveDisabled = true
}

export function resetKeepAliveForTesting(): void {
  keepAliveDisabled = false
}

export function getAddressFamily(options: LookupOptions): 0 | 4 | 6 {
  const family = options.family
  if (family === 0 || family === 4 || family === 6) {
    return family
  }
  if (family === undefined || family === 'IPv4') {
    return 4
  }
  if (family === 'IPv6') {
    return 6
  }
  throw new Error(`Invalid address family: ${String(family)}`)
}

export function getProxyUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
  )
}

export function getNoProxy(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.no_proxy || env.NO_PROXY
}

export function shouldBypassProxy(
  urlString: string,
  noProxy: string | undefined = getNoProxy(),
): boolean {
  if (!noProxy || noProxy.trim() === '') {
    return false
  }
  const trimmed = noProxy.trim()
  if (trimmed === '*') {
    return true
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(urlString)
  } catch {
    return false
  }

  const hostname = parsedUrl.hostname.toLowerCase()
  const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80')
  const patterns = trimmed.split(/[,\s]+/).filter(Boolean)

  for (const rawPattern of patterns) {
    const pattern = rawPattern.toLowerCase()
    if (pattern === '*') {
      return true
    }
    if (pattern.includes(':')) {
      if (`${hostname}:${port}` === pattern) {
        return true
      }
      continue
    }
    if (pattern.startsWith('.')) {
      if (hostname === pattern.slice(1) || hostname.endsWith(pattern)) {
        return true
      }
      continue
    }
    if (hostname === pattern) {
      return true
    }
  }

  return false
}

function createHttpsProxyAgent(
  proxyUrl: string,
  extra: HttpsProxyAgentOptions<string> = {},
): HttpsProxyAgent<string> {
  const mtlsConfig = getMtlsConfig()
  const caCerts = getCaCertificates()
  const proxyResolvesHosts = isEnvTruthy(
    process.env.COPILOT_CLI_PROXY_RESOLVES_HOSTS,
  )

  return new HttpsProxyAgent(proxyUrl, {
    ...mtlsConfig,
    ...(caCerts ? { ca: caCerts } : {}),
    ...(proxyResolvesHosts
      ? {
          lookup: (
            hostname: string,
            options: LookupOptions,
            callback: (
              err: NodeJS.ErrnoException | null,
              address: string,
              family: number,
            ) => void,
          ) => {
            callback(null, hostname, getAddressFamily(options))
          },
        }
      : {}),
    ...extra,
  })
}

export function createAxiosInstance(
  extra: HttpsProxyAgentOptions<string> = {},
): AxiosInstance {
  const instance = axios.create({ proxy: false })
  const proxyUrl = getProxyUrl()
  const mtlsAgent = getMtlsAgent()

  if (!proxyUrl) {
    if (mtlsAgent) {
      instance.defaults.httpsAgent = mtlsAgent
    }
    return instance
  }

  const proxyAgent = createHttpsProxyAgent(proxyUrl, extra)
  instance.interceptors.request.use(config => {
    const targetUrl = config.baseURL
      ? new URL(config.url ?? '', config.baseURL).toString()
      : (config.url ?? '')
    if (targetUrl && shouldBypassProxy(targetUrl)) {
      config.httpAgent = undefined
      config.httpsAgent = mtlsAgent
    } else {
      config.httpAgent = proxyAgent
      config.httpsAgent = proxyAgent
    }
    return config
  })

  return instance
}

export const getProxyAgent = memoize((uri: string): undici.Dispatcher => {
  const undiciMod = require('undici') as typeof import('undici')
  const mtlsConfig = getMtlsConfig()
  const caCerts = getCaCertificates()
  const tlsOpts =
    mtlsConfig || caCerts
      ? {
          ...mtlsConfig,
          ...(caCerts ? { ca: caCerts } : {}),
        }
      : undefined

  return new undiciMod.EnvHttpProxyAgent({
    httpProxy: uri,
    httpsProxy: uri,
    noProxy: process.env.NO_PROXY || process.env.no_proxy,
    ...(tlsOpts ? { requestTls: tlsOpts } : {}),
  })
})

export function getWebSocketProxyAgent(url: string): Agent | undefined {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl || shouldBypassProxy(url)) {
    return undefined
  }
  return createHttpsProxyAgent(proxyUrl)
}

export function getWebSocketProxyUrl(url: string): string | undefined {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl || shouldBypassProxy(url)) {
    return undefined
  }
  return proxyUrl
}

export function getProxyFetchOptions(options?: {
  forAnthropicApi?: boolean
}): {
  tls?: TlsConfig
  dispatcher?: undici.Dispatcher
  proxy?: string
  unix?: string
  keepalive?: false
} {
  const base: { keepalive?: false } = keepAliveDisabled
    ? { keepalive: false }
    : {}

  if (
    options?.forAnthropicApi &&
    process.env.ANTHROPIC_UNIX_SOCKET &&
    typeof Bun !== 'undefined'
  ) {
    return { ...base, unix: process.env.ANTHROPIC_UNIX_SOCKET }
  }

  const proxyUrl = getProxyUrl()
  if (proxyUrl) {
    if (typeof Bun !== 'undefined') {
      return { ...base, proxy: proxyUrl, ...getTlsFetchOptions() }
    }
    return { ...base, dispatcher: getProxyAgent(proxyUrl) }
  }

  return { ...base, ...getTlsFetchOptions() }
}

export function configureGlobalAgents(): void {
  if (proxyInterceptorId !== null) {
    axios.interceptors.request.eject(proxyInterceptorId)
    proxyInterceptorId = null
  }

  axios.defaults.proxy = undefined
  axios.defaults.httpAgent = undefined
  axios.defaults.httpsAgent = undefined

  const proxyUrl = getProxyUrl()
  const mtlsAgent = getMtlsAgent()

  if (proxyUrl) {
    const proxyAgent = createHttpsProxyAgent(proxyUrl)
    axios.defaults.proxy = false
    proxyInterceptorId = axios.interceptors.request.use(config => {
      const targetUrl = config.baseURL
        ? new URL(config.url ?? '', config.baseURL).toString()
        : (config.url ?? '')
      if (targetUrl && shouldBypassProxy(targetUrl)) {
        config.httpAgent = undefined
        config.httpsAgent = mtlsAgent
      } else {
        config.httpAgent = proxyAgent
        config.httpsAgent = proxyAgent
      }
      return config
    })

    try {
      const undiciMod = require('undici') as typeof import('undici')
      undiciMod.setGlobalDispatcher(getProxyAgent(proxyUrl))
    } catch {
      // Ignore if undici global dispatcher cannot be configured
    }
    return
  }

  if (mtlsAgent) {
    axios.defaults.httpsAgent = mtlsAgent
    const { dispatcher } = getTlsFetchOptions()
    if (dispatcher) {
      try {
        const undiciMod = require('undici') as typeof import('undici')
        undiciMod.setGlobalDispatcher(dispatcher)
      } catch {
        // Ignore if undici global dispatcher cannot be configured
      }
    }
  }
}

export async function getAwsClientProxyConfig(): Promise<
  Record<string, unknown>
> {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl) {
    return {}
  }
  return { proxyUrl }
}

export function clearProxyCache(): void {
  getProxyAgent.cache.clear?.()
}

/**
 * HTTP Hook executor (`execHttpHook`) with defense-in-depth protections:
 * - `allowedHttpHookUrls` wildcard policy allowlist checked before any I/O
 * - Safe `$VAR` / `${VAR}` header interpolation strictly scoped to
 *   `hook.allowedEnvVars ∩ settings.httpHookAllowedEnvVars`
 * - Header-name validation & CR/LF/NUL value sanitization (prevents CRLF header injection!)
 * - `maxRedirects: 0` (prevents open-redirect SSRF bypass)
 * - DNS-level `ssrfGuardedLookup` (blocks private/link-local/metadata/IPv4-mapped IPv6
 *   while allowing loopback `127.0.0.1`/`::1`)
 * - Routes through OS sandbox HTTP proxy when active
 */

import http from 'http'
import https from 'https'
import type { HttpHook } from '../../schemas/hooks.js'
import type { HookEvent } from '../../types/hooks.js'
import { createCombinedAbortSignal } from '../combined_abort_signal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { SandboxManager } from '../sandbox/sandbox_adapter.js'
import * as settingsModule from '../settings/settings.js'
import { isBlockedAddress, ssrfGuardedLookup } from './ssrf_guard.js'
import { isIP } from 'net'

const DEFAULT_HTTP_HOOK_TIMEOUT_MS = 60_000
const VALID_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function urlMatchesPattern(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regexStr = escaped.replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`).test(url)
}

/**
 * Strips CR, LF, and NUL bytes to prevent HTTP CRLF header injection.
 */
export function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\x00]/g, '')
}

/**
 * Interpolates `$VAR` and `${VAR}` ONLY for variables explicitly present in
 * `allowedEnvVars`, replacing unlisted variables with empty strings and
 * sanitizing the resulting value against CRLF header injection.
 */
export function interpolateHttpHookHeaderValue(
  value: string,
  allowedEnvVars: ReadonlySet<string>,
): string {
  const interpolated = value.replace(
    /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g,
    (_match, braced: string | undefined, unbraced: string | undefined) => {
      const varName = braced ?? unbraced ?? ''
      if (!allowedEnvVars.has(varName)) {
        logForDebugging(
          `Hooks: env var $${varName} not in allowedEnvVars, omitting`,
          { level: 'warn' },
        )
        return ''
      }
      return process.env[varName] ?? ''
    },
  )
  return sanitizeHeaderValue(interpolated)
}

export interface HttpHookExecResult {
  ok: boolean
  statusCode?: number
  body: string
  error?: string
  aborted?: boolean
}

export async function execHttpHook(
  hook: HttpHook,
  _hookEvent: HookEvent,
  jsonInput: string,
  signal?: AbortSignal,
): Promise<HttpHookExecResult> {
  const settings = settingsModule.getSettings()
  const allowedUrls = settings.allowedHttpHookUrls
  const policyAllowedEnvVars = settings.httpHookAllowedEnvVars

  // 1. Enforce URL allowlist before any network/DNS I/O
  if (allowedUrls !== undefined) {
    const matched = allowedUrls.some(pat => urlMatchesPattern(hook.url, pat))
    if (!matched) {
      const msg = `HTTP hook blocked: ${hook.url} does not match allowedHttpHookUrls`
      logForDebugging(msg, { level: 'warn' })
      return { ok: false, body: '', error: msg }
    }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(hook.url)
  } catch {
    return { ok: false, body: '', error: `Invalid HTTP hook URL: ${hook.url}` }
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      body: '',
      error: `Unsupported protocol for HTTP hook: ${parsedUrl.protocol}`,
    }
  }

  // 2. Build sanitized headers (validate header names + strip CRLF/NUL from values)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(jsonInput, 'utf8')),
  }

  if (hook.headers) {
    const hookVars = hook.allowedEnvVars ?? []
    const effectiveVars =
      policyAllowedEnvVars !== undefined
        ? hookVars.filter(v => policyAllowedEnvVars.includes(v))
        : hookVars
    const allowedSet = new Set(effectiveVars)

    for (const [name, rawVal] of Object.entries(hook.headers)) {
      if (!VALID_HEADER_NAME_RE.test(name)) {
        return {
          ok: false,
          body: '',
          error: `HTTP hook blocked: invalid header name '${name.replace(/[\r\n]/g, '')}' (header injection prevented)`,
        }
      }
      headers[name] = interpolateHttpHookHeaderValue(rawVal, allowedSet)
    }
  }

  // 3. Direct IP literal pre-check before socket creation (catches literal IPv4/IPv6 immediately)
  const bareHost = parsedUrl.hostname.replace(/^\[|\]$/g, '')
  const sandboxProxyPort = SandboxManager.isSandboxingEnabled()
    ? (await SandboxManager.waitForNetworkInitialization(),
      SandboxManager.getProxyPort())
    : undefined

  if (!sandboxProxyPort && isIP(bareHost) && isBlockedAddress(bareHost)) {
    return {
      ok: false,
      body: '',
      error: `SSRF guard blocked request to restricted IP address: ${bareHost}`,
    }
  }

  const timeoutMs = hook.timeout
    ? hook.timeout * 1000
    : DEFAULT_HTTP_HOOK_TIMEOUT_MS

  const { signal: combinedSignal, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs,
  })

  try {
    return await new Promise<HttpHookExecResult>(resolvePromise => {
      const isHttps = parsedUrl.protocol === 'https:'
      const requester = sandboxProxyPort ? http : isHttps ? https : http

      const reqOptions: http.RequestOptions = sandboxProxyPort
        ? {
            hostname: '127.0.0.1',
            port: sandboxProxyPort,
            path: hook.url,
            method: 'POST',
            headers: {
              ...headers,
              Host: parsedUrl.host,
            },
          }
        : {
            hostname: bareHost,
            port: parsedUrl.port
              ? Number.parseInt(parsedUrl.port, 10)
              : isHttps
                ? 443
                : 80,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method: 'POST',
            headers,
            lookup: ssrfGuardedLookup as unknown as http.RequestOptions['lookup'],
          }

      const req = requester.request(reqOptions, res => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          cleanup()
          const body = Buffer.concat(chunks).toString('utf8')
          const statusCode = res.statusCode ?? 0
          // Never follow redirects (`maxRedirects: 0`)
          if (statusCode >= 300 && statusCode < 400) {
            resolvePromise({
              ok: false,
              statusCode,
              body,
              error: `HTTP hook rejected redirect response (HTTP ${statusCode})`,
            })
            return
          }
          resolvePromise({
            ok: statusCode >= 200 && statusCode < 300,
            statusCode,
            body,
          })
        })
      })

      const onAbort = () => {
        req.destroy()
        cleanup()
        resolvePromise({ ok: false, body: '', aborted: true })
      }
      if (combinedSignal.aborted) {
        onAbort()
        return
      }
      combinedSignal.addEventListener('abort', onAbort, { once: true })

      req.on('error', err => {
        cleanup()
        if (combinedSignal.aborted) {
          resolvePromise({ ok: false, body: '', aborted: true })
          return
        }
        resolvePromise({
          ok: false,
          body: '',
          error: errorMessage(err),
        })
      })

      req.write(jsonInput)
      req.end()
    })
  } finally {
    cleanup()
  }
}

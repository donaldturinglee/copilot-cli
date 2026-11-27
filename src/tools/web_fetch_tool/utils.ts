/**
 * URL validation, HTTP->HTTPS upgrade, safe same-host/www redirect traversal,
 * 15-minute / 50 MB LRU caching, and lazy `turndown` HTML-to-Markdown
 * conversion for `WebFetchTool`.
 */

import { LRUCache } from 'lru-cache'

export const WEB_FETCH_MAX_URL_LENGTH = 2_000
export const WEB_FETCH_MAX_REDIRECTS = 10
export const WEB_FETCH_TIMEOUT_MS = 60_000
export const WEB_FETCH_MAX_RESPONSE_BYTES = 10 * 1024 * 1024 // 10 MB
export const WEB_FETCH_MAX_CONTENT_CHARS = 100_000
export const WEB_FETCH_CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
export const WEB_FETCH_CACHE_MAX_BYTES = 50 * 1024 * 1024 // 50 MB

export interface FetchedUrlResponse {
  bytes: number
  code: number
  codeText: string
  content: string
  contentType: string
  url: string
  redirectedToDifferentHost?: string
}

const urlCache = new LRUCache<string, FetchedUrlResponse>({
  ttl: WEB_FETCH_CACHE_TTL_MS,
  maxSize: WEB_FETCH_CACHE_MAX_BYTES,
  sizeCalculation: val => Math.max(1, val.content.length * 2),
})

export function clearWebFetchCache(): void {
  urlCache.clear()
}

function isLocalhost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '[::1]'
  )
}

/**
 * Validates a URL for `WebFetch`, rejecting non-HTTP(S) schemes, excessive
 * lengths, and embedded credentials, and upgrading `http:` -> `https:` for
 * non-localhost URLs.
 */
export function validateWebFetchUrl(rawUrl: string):
  | { valid: true; url: string; parsed: URL }
  | { valid: false; error: string } {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return { valid: false, error: 'URL must not be empty.' }
  }
  if (trimmed.length > WEB_FETCH_MAX_URL_LENGTH) {
    return {
      valid: false,
      error: `URL length (${trimmed.length}) exceeds maximum (${WEB_FETCH_MAX_URL_LENGTH}).`,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { valid: false, error: `Invalid URL: ${rawUrl}` }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: `Unsupported URL protocol "${parsed.protocol}". Only http: and https: are allowed.`,
    }
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: 'URLs with embedded credentials are not allowed.',
    }
  }

  if (parsed.protocol === 'http:' && !isLocalhost(parsed.hostname)) {
    parsed.protocol = 'https:'
  }

  return { valid: true, url: parsed.toString(), parsed }
}

function stripWww(hostname: string): string {
  const lower = hostname.toLowerCase()
  return lower.startsWith('www.') ? lower.slice(4) : lower
}

/**
 * Returns true if redirecting from `fromUrl` to `toUrl` stays on the same
 * hostname (or differs only by a leading `www.` prefix).
 */
export function isPermittedRedirect(fromUrl: string, toUrl: string): boolean {
  try {
    const a = new URL(fromUrl)
    const b = new URL(toUrl)
    if (b.protocol !== 'http:' && b.protocol !== 'https:') {
      return false
    }
    return stripWww(a.hostname) === stripWww(b.hostname)
  } catch {
    return false
  }
}

let cachedTurndown:
  | { turndown(html: string): string }
  | undefined

/**
 * Lazily loads `turndown` and converts an HTML document into clean Markdown.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  if (!cachedTurndown) {
    const mod = await import('turndown')
    const TurndownService =
      (mod as unknown as { default?: new (opts?: Record<string, unknown>) => { turndown(s: string): string; remove(tags: string[]): void } }).default ??
      (mod as unknown as new (opts?: Record<string, unknown>) => { turndown(s: string): string; remove(tags: string[]): void })
    const svc = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    })
    svc.remove(['script', 'style', 'noscript'])
    cachedTurndown = svc
  }
  return cachedTurndown.turndown(html)
}

/**
 * Fetches `url` with a manual redirect loop (capped at 10 same-host/www hops),
 * cross-host redirect detection, 15-minute LRU caching, and HTML-to-Markdown
 * conversion.
 */
export async function fetchUrlWithSafeRedirects(
  url: string,
  abortSignal?: AbortSignal,
  options?: {
    fetchImpl?: typeof fetch
    bypassCache?: boolean
  },
): Promise<FetchedUrlResponse> {
  const validated = validateWebFetchUrl(url)
  if (!validated.valid) {
    throw new Error(validated.error)
  }

  const normalizedUrl = validated.url
  if (!options?.bypassCache) {
    const cached = urlCache.get(normalizedUrl)
    if (cached) {
      return cached
    }
  }

  const fetchFn = options?.fetchImpl ?? fetch
  let currentUrl = normalizedUrl

  for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop++) {
    const timeoutController = new AbortController()
    const timer = setTimeout(
      () => timeoutController.abort(),
      WEB_FETCH_TIMEOUT_MS,
    )
    timer.unref?.()

    const onParentAbort = () => timeoutController.abort()
    abortSignal?.addEventListener('abort', onParentAbort, { once: true })

    let response: Response
    try {
      response = await fetchFn(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: timeoutController.signal,
        headers: {
          Accept: 'text/markdown, text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.8',
          'User-Agent': 'CopilotCLI/1.0',
        },
      })
    } finally {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onParentAbort)
    }

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get('location')
    ) {
      const location = response.headers.get('location')!
      const nextUrl = new URL(location, currentUrl).toString()
      if (!isPermittedRedirect(currentUrl, nextUrl)) {
        return {
          bytes: 0,
          code: response.status,
          codeText: response.statusText || 'Redirect',
          content: `REDIRECT DETECTED: ${currentUrl} redirected to a different host: ${nextUrl}. Make a new WebFetch request with the redirect URL if you want to fetch it.`,
          contentType: 'text/plain',
          url: currentUrl,
          redirectedToDifferentHost: nextUrl,
        }
      }
      if (hop === WEB_FETCH_MAX_REDIRECTS) {
        throw new Error(
          `Exceeded maximum redirect limit (${WEB_FETCH_MAX_REDIRECTS}) while fetching ${url}.`,
        )
      }
      currentUrl = nextUrl
      continue
    }

    const arrayBuf = await response.arrayBuffer()
    const byteLen = arrayBuf.byteLength
    if (byteLen > WEB_FETCH_MAX_RESPONSE_BYTES) {
      throw new Error(
        `Response size (${Math.round(byteLen / (1024 * 1024))}MB) exceeds maximum allowed (${WEB_FETCH_MAX_RESPONSE_BYTES / (1024 * 1024)}MB).`,
      )
    }

    const rawText = Buffer.from(arrayBuf).toString('utf8')
    const contentType = response.headers.get('content-type') ?? 'text/plain'
    let content = rawText
    if (contentType.toLowerCase().includes('text/html')) {
      content = await htmlToMarkdown(rawText)
    }
    if (content.length > WEB_FETCH_MAX_CONTENT_CHARS) {
      content =
        content.slice(0, WEB_FETCH_MAX_CONTENT_CHARS) +
        '\n\n[Content truncated at 100,000 characters]'
    }

    const result: FetchedUrlResponse = {
      bytes: byteLen,
      code: response.status,
      codeText: response.statusText || 'OK',
      content,
      contentType,
      url: currentUrl,
    }

    if (response.ok && !options?.bypassCache) {
      urlCache.set(normalizedUrl, result)
    }
    return result
  }

  throw new Error(`Failed to fetch ${url}`)
}

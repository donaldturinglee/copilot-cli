/**
 * Lightweight rate-limit mocking hook interface so production header parsing
 * stays decoupled from ant-only mock rate-limit presets.
 */

export interface MockRateLimitInterceptor {
  isActive: () => boolean
  processHeaders: (headers: Headers) => Headers
  checkError: (model: string, fastModeActive: boolean) => Error | null
}

let activeInterceptor: MockRateLimitInterceptor | null = null

/**
 * Registers the mock rate-limit interceptor (used by `mock_rate_limits.ts` and tests).
 */
export function registerMockRateLimitInterceptor(
  interceptor: MockRateLimitInterceptor | null,
): void {
  activeInterceptor = interceptor
}

/**
 * Returns true if rate-limit response headers should be processed for the
 * current user (either real Claude.ai subscriber or active mock interceptor).
 */
export function shouldProcessRateLimits(isSubscriber: boolean): boolean {
  return isSubscriber || Boolean(activeInterceptor?.isActive())
}

/**
 * Transforms incoming HTTP headers through any active mock rate-limit interceptor.
 */
export function processRateLimitHeaders(headers: Headers): Headers {
  if (activeInterceptor?.isActive()) {
    return activeInterceptor.processHeaders(headers)
  }
  return headers
}

/**
 * Checks whether a mocked rate-limit error should be thrown before an API call.
 */
export function checkMockRateLimitError(
  model: string,
  fastModeActive: boolean,
): Error | null {
  if (activeInterceptor?.isActive()) {
    return activeInterceptor.checkError(model, fastModeActive)
  }
  return null
}

/**
 * Returns true if an error was injected by the mock rate-limit harness.
 */
export function isMockRateLimitError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'isMockRateLimitError' in error &&
    (error as { isMockRateLimitError?: unknown }).isMockRateLimitError === true
  )
}

/**
 * Initializes bundled built-in plugins at CLI startup.
 */

let initialized = false

/**
 * Initializes built-in bundled plugins idempotently.
 */
export function initBuiltinPlugins(): void {
  if (initialized) {
    return
  }
  initialized = true
}
